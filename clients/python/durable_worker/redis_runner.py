"""Run a :class:`Worker` against the BullMQ/Redis transport.

Consumes the orchestrator's per-group tasks queue and publishes results on the shared results
queue — the same queues a TypeScript ``BullMQTransport`` uses, so steps interoperate across
languages. Requires the optional ``bullmq`` extra: ``pip install durable-worker[redis]``.

It also subscribes to the orchestrator's control channel (``<prefix>-control``) so a long handler
can observe cooperative cancellation via ``ctx.cancelled`` — the cross-language half of
``engine.cancel``.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
from typing import Any, Callable, Dict, Optional

from .cancellation import CancellationRegistry
from .worker import Worker

# Stable-ish id for the `from` field of control messages this worker publishes. It only has to
# DIFFER from the engine instanceIds (so a dashboard engine doesn't treat our progress events as its
# own echo and drop them) — host + pid is plenty and avoids importing a uuid/random dependency.
_INSTANCE_ID = f"py-{socket.gethostname()}-{os.getpid()}"


def _names(prefix: str, group: str) -> tuple[str, str]:
    # Must match the TS BullMQTransport: '<prefix>-tasks-<group>' and '<prefix>-results'.
    return f"{prefix}-tasks-{group}", f"{prefix}-results"


def _control_channel(prefix: str) -> str:
    # Mirrors BullMQTransport.controlChannel(): '<prefix>-control'.
    return f"{prefix}-control"


def _progress_message(task: Dict[str, Any], event: Dict[str, Any]) -> str:
    """A control-plane `{kind:'event'}` carrying a `step.progress` EngineEvent — the same envelope a
    TS engine publishes, so a dashboard engine re-delivers it to its subscribers (live-tail). Carries
    the single just-emitted step event; the `at` mirrors EngineEvent's (ms; the TS side `new Date()`s it)."""
    return json.dumps(
        {
            "kind": "event",
            "from": _INSTANCE_ID,
            "event": {
                "type": "step.progress",
                "runId": task.get("runId"),
                "seq": task.get("seq"),
                "name": task.get("name"),
                "event": event,
                "at": event.get("at"),
            },
        }
    )


async def run_redis_worker(
    worker: Worker,
    *,
    group: str,
    connection: str = "redis://localhost:6379",
    prefix: str = "durable",
    cancellation: Optional[CancellationRegistry] = None,
) -> Any:
    """Start a BullMQ worker that runs ``worker``'s handlers. Returns the bullmq Worker.

    The returned worker runs in the background; ``await worker.close()`` to stop it. When a
    :class:`CancellationRegistry` is given (one is created otherwise), the runner subscribes to the
    control channel and feeds it, so handlers see ``ctx.cancelled``.
    """

    from bullmq import Queue as BullQueue  # imported lazily so the SDK works without bullmq
    from bullmq import Worker as BullWorker

    tasks_name, results_name = _names(prefix, group)
    results = BullQueue(results_name, {"connection": connection})
    registry = cancellation or CancellationRegistry()
    await _subscribe_control(connection, prefix, registry)
    publish_progress = await _progress_publisher(connection, prefix)

    async def process(job: Any, _token: str) -> None:
        on_event = _make_on_event(job.data, publish_progress) if publish_progress else None
        result = await worker.aprocess_task(
            job.data, is_cancelled=registry.is_cancelled, on_event=on_event
        )
        await results.add("result", result, {"removeOnComplete": True, "removeOnFail": True})

    return BullWorker(tasks_name, process, {"connection": connection})


async def _progress_publisher(
    connection: str, prefix: str
) -> Optional[Callable[[str], None]]:
    """Build a thread-safe `publish(message)` that PUBLISHes on the control channel from the running
    loop. Returns None if redis pub/sub isn't available (then `step.progress` streaming is simply off
    — the events still ride back on the final result). The returned callable is safe to call from a
    handler's executor thread: it hops back onto the loop via ``call_soon_threadsafe`` (the aioredis
    client is bound to this loop, so publishing must happen there, not from the worker thread)."""
    try:
        import redis.asyncio as aioredis  # lazy: only needed when streaming progress
    except ImportError:
        return None

    client = aioredis.from_url(connection)
    channel = _control_channel(prefix)
    loop = asyncio.get_running_loop()

    def publish(message: str) -> None:
        async def _send() -> None:
            try:
                await client.publish(channel, message)
            except Exception:  # noqa: BLE001 — live-tail is best-effort; never fail the step
                pass

        try:
            loop.call_soon_threadsafe(lambda: loop.create_task(_send()))
        except RuntimeError:
            pass  # loop is closing/closed — drop the live event (the result still carries it)

    return publish


def _make_on_event(
    task: Dict[str, Any], publish: Callable[[str], None]
) -> Callable[[Dict[str, Any]], None]:
    """Per-task sink: turn each step event into a `step.progress` control message and publish it."""

    def on_event(event: Dict[str, Any]) -> None:
        publish(_progress_message(task, event))

    return on_event


async def _subscribe_control(
    connection: str, prefix: str, registry: CancellationRegistry
) -> None:
    """Best-effort: subscribe to the control channel and feed cancellations into ``registry``.
    No-op (logged) if redis pub/sub isn't available — cancellation just won't be observed."""
    try:
        import redis.asyncio as aioredis  # lazy: only needed for cooperative cancellation
    except ImportError:
        return

    client = aioredis.from_url(connection)
    pubsub = client.pubsub()
    await pubsub.subscribe(_control_channel(prefix))

    async def listen() -> None:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                registry.on_control_message(json.loads(message["data"]))
            except (ValueError, TypeError):
                pass  # ignore malformed control messages

    asyncio.create_task(listen())
