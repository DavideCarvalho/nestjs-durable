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
from typing import Any, Optional

from .cancellation import CancellationRegistry
from .worker import Worker


def _names(prefix: str, group: str) -> tuple[str, str]:
    # Must match the TS BullMQTransport: '<prefix>-tasks-<group>' and '<prefix>-results'.
    return f"{prefix}-tasks-{group}", f"{prefix}-results"


def _control_channel(prefix: str) -> str:
    # Mirrors BullMQTransport.controlChannel(): '<prefix>-control'.
    return f"{prefix}-control"


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

    async def process(job: Any, _token: str) -> None:
        result = await worker.aprocess_task(job.data, is_cancelled=registry.is_cancelled)
        await results.add("result", result, {"removeOnComplete": True, "removeOnFail": True})

    return BullWorker(tasks_name, process, {"connection": connection})


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
