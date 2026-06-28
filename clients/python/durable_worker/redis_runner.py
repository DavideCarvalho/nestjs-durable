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
import time
from typing import Any, Callable, Dict, Optional

from .adaptive import AdaptiveController, resolve_concurrency
from .cancellation import CancellationRegistry
from .worker import Worker
from .workflow import is_workflow_task

# asyncio keeps only a WEAK reference to a task, so a fire-and-forget task created without retaining
# its handle can be garbage-collected mid-flight — which surfaces as "Task was destroyed but it is
# pending!" and silently kills the long-lived background loops (heartbeat, control-channel listener).
# Retaining the handle here for the lifetime of the worker process is the documented fix; the
# done-callback drops it so the set doesn't grow unbounded. See the asyncio.create_task docs.
_BACKGROUND_TASKS: set = set()


def _spawn_retained(coro: Any) -> "asyncio.Task[Any]":
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return task

# Stable-ish id for the `from` field of control messages this worker publishes. It only has to
# DIFFER from the engine instanceIds (so a dashboard engine doesn't treat our progress events as its
# own echo and drop them) — host + pid is plenty and avoids importing a uuid/random dependency.
_INSTANCE_ID = f"py-{socket.gethostname()}-{os.getpid()}"

# Worker liveness heartbeat. The worker stamps a TTL'd key every INTERVAL seconds; if the worker
# dies or its loop stalls, the key expires after TTL and the *absence* is the alert signal a monitor
# watches for. TTL is comfortably larger than the interval so a single slow refresh doesn't flap.
_HEARTBEAT_INTERVAL_SECONDS = 10
_HEARTBEAT_TTL_SECONDS = 35

# Per-RUN liveness heartbeat emitted WHILE a workflow turn is replaying. The TS engine, while it
# awaits a remote `advance`, re-arms its `remoteAdvanceSilenceMs` deadline on each run-scoped beat and
# re-drives the run if the worker goes silent. So a slow-but-alive replay must beat every few seconds
# to prove it's still working and avoid being wrongly re-driven. Distinct from the per-WORKER TTL key
# above: this rides the engine's pub/sub `<prefix>-heartbeat` channel, beats faster, and is keyed by
# runId (no stepId), so the engine resets the run's liveness deadline.
_BEAT_INTERVAL_SECONDS = 5


def _heartbeat_key(prefix: str, group: str) -> str:
    """Per-(group, instance) liveness key. Mirrors the queue-name convention ('<prefix>-...') so the
    whole durable keyspace shares one prefix. A monitor can scan '<prefix>-worker-heartbeat:<group>:*'."""
    return f"{prefix}-worker-heartbeat:{group}:{_INSTANCE_ID}"


async def _verify_connection(connection: str) -> None:
    """Fail FAST if Redis is unreachable. bullmq's Worker connects lazily and swallows the resulting
    ConnectionError inside a background task ("Task exception was never retrieved"), so a misconfigured
    connection (wrong host, missing auth) leaves a process that is alive but consumes nothing — silent.
    PING up front so the failure propagates out of run()/run_workers and the process exits non-zero,
    letting a supervisor respawn it into a visible crash-loop instead of a silent dead worker."""
    try:
        import redis.asyncio as aioredis  # lazy: same client bullmq uses under the hood
    except ImportError:
        return  # no redis client present — bullmq import would have failed first; nothing to verify
    client = aioredis.from_url(connection)
    try:
        await client.ping()
    except Exception as err:  # noqa: BLE001 — re-raised with a clearer, actionable message
        raise ConnectionError(
            f"durable-worker could not reach Redis (ping failed: {err}). Refusing to start a worker "
            "that would consume nothing. Check the REDIS_* connection settings."
        ) from err
    finally:
        closer = getattr(client, "aclose", None) or getattr(client, "close", None)
        if closer:
            try:
                await closer()
            except Exception:  # noqa: BLE001 — teardown of the probe connection is best-effort
                pass


def _heartbeat_value(controller: Optional[AdaptiveController]) -> str:
    """The heartbeat key's value: JSON ``{"ts": <epochMs>, "status": <WorkerStatus>}``.

    ``ts`` is epoch MILLISECONDS (not seconds — readers normalize seconds→ms only as a legacy
    fallback). ``status`` is the controller's live snapshot when one is wired (it always is for step
    workers, omitted for the workflow worker). Readers accept both this JSON form and the legacy bare
    number, so emitting JSON stays backward-compatible."""
    payload: Dict[str, Any] = {"ts": int(time.time() * 1000)}
    if controller is not None:
        payload["status"] = controller.snapshot()
    return json.dumps(payload)


async def _start_heartbeat(
    connection: str, prefix: str, group: str, controller: Optional[AdaptiveController] = None
) -> None:
    """Spawn a background task that refreshes the worker's TTL'd heartbeat key. Best-effort: a failed
    refresh is swallowed (the key then expires and the gap is itself the signal) and the whole thing
    is a no-op when redis isn't available. The SET round-trips to Redis, so the heartbeat doubles as
    an ongoing connectivity probe — if Redis drops, the key stops refreshing and expires.

    When a ``controller`` is supplied the value carries the live ``WorkerStatus`` snapshot, refreshed
    on every beat (cheap — we're already beating)."""
    try:
        import redis.asyncio as aioredis  # lazy: only needed when a transport is actually running
    except ImportError:
        return
    client = aioredis.from_url(connection)
    key = _heartbeat_key(prefix, group)

    async def beat() -> None:
        while True:
            try:
                await client.set(key, _heartbeat_value(controller), ex=_HEARTBEAT_TTL_SECONDS)
            except Exception:  # noqa: BLE001 — never let a heartbeat hiccup kill the worker
                pass
            await asyncio.sleep(_HEARTBEAT_INTERVAL_SECONDS)

    _spawn_retained(beat())


def _run_heartbeat_channel(prefix: str) -> str:
    """Pub/sub channel for run-scoped liveness beats. MUST match the channel the TS engine's transport
    subscribes to: '<prefix>-heartbeat'."""
    return f"{prefix}-heartbeat"


def _run_heartbeat_client(connection: str) -> Optional[Any]:
    """Lazily build the aioredis client used to PUBLISH run-scoped beats. One client per worker (not
    per turn). Returns None when redis isn't importable — then per-run beating is simply off (a no-op),
    exactly like ``_start_heartbeat`` when the dependency is missing."""
    try:
        import redis.asyncio as aioredis  # lazy: only needed when a transport is actually running
    except ImportError:
        return None
    return aioredis.from_url(connection)


async def _beat_run(client: Any, channel: str, run_id: Any, group: str) -> None:
    """Publish a run-scoped liveness beat immediately, then every ``_BEAT_INTERVAL_SECONDS`` while the
    turn runs. The payload OMITS ``stepId`` so the engine keys the liveness reset by ``runId``. Cadence
    and best-effort error handling mirror ``_start_heartbeat``: a failed publish is swallowed so a
    redis hiccup never breaks the in-flight turn. The caller cancels this task when the turn settles."""
    payload = json.dumps({"runId": run_id, "seq": 0, "group": group})
    while True:
        try:
            await client.publish(channel, payload)
        except Exception:  # noqa: BLE001 — never let a heartbeat hiccup break the running turn
            pass
        await asyncio.sleep(_BEAT_INTERVAL_SECONDS)


def redis_url_from_env(prefix: str = "REDIS") -> str:
    """Build a ``redis://`` URL from ``{prefix}_HOST/_PORT/_USERNAME/_PASSWORD`` env vars. The
    credentials are URL-encoded — a generated password often contains ``@ : /`` which would corrupt
    the netloc if left raw. Defaults to ``localhost:6379`` with no auth. Handy for ``Worker.run``."""
    from urllib.parse import quote

    host = os.getenv(f"{prefix}_HOST", "localhost")
    port = os.getenv(f"{prefix}_PORT", "6379")
    user = os.getenv(f"{prefix}_USERNAME") or ""
    password = os.getenv(f"{prefix}_PASSWORD") or ""
    auth = f"{quote(user, safe='')}:{quote(password, safe='')}@" if (user or password) else ""
    return f"redis://{auth}{host}:{port}"


def _names(prefix: str, group: str) -> tuple[str, str]:
    # Must match the TS BullMQTransport: '<prefix>-tasks-<group>' and '<prefix>-results'.
    return f"{prefix}-tasks-{group}", f"{prefix}-results"


async def run_redis_workflow_worker(
    workflow_worker: Any,
    *,
    group: str,
    connection: str = "redis://localhost:6379",
    prefix: str = "durable",
    cancellation: Optional[CancellationRegistry] = None,
) -> Any:
    """Start a BullMQ worker that REPLAYS workflow tasks. Consumes the group's task queue (each job is
    a WorkflowTask) and publishes the resulting WorkflowDecision on ``<prefix>-decisions`` — the queues
    the engine's remote workflow executor dispatches over. Returns the bullmq Worker (``await
    worker.close()`` to stop). Replay is sync + pure, so this is a thin transport shell over
    ``workflow_worker.process_task``.

    Subscribes to the control channel and feeds a :class:`CancellationRegistry` (created if none is
    given), so a cancelled run's replay bails at the next op boundary — automatic between-step
    cancellation — and handlers see ``ctx.cancelled`` for cooperative mid-step aborts."""
    from bullmq import Queue as BullQueue
    from bullmq import Worker as BullWorker

    await _verify_connection(connection)

    tasks_name = f"{prefix}-tasks-{group}"
    decisions = BullQueue(f"{prefix}-decisions", {"connection": connection})
    step_events = BullQueue(f"{prefix}-step-events", {"connection": connection})
    publish_step = _step_event_publisher(step_events)
    registry = cancellation or CancellationRegistry()
    await _subscribe_control(connection, prefix, registry)

    # One publisher client per worker (not per turn). The per-turn beat task just borrows it.
    beat_client = _run_heartbeat_client(connection)
    beat_channel = _run_heartbeat_channel(prefix)

    async def process(job: Any, _token: str) -> Any:
        # Replay OFF the event loop. `process_task` is fully synchronous and a real workflow turn can
        # run for minutes (e.g. a body of inline ctx.step DB calls). Running it inline would block the
        # loop that drives (a) this worker's liveness heartbeat — so it'd read as "0 live workers" mid-
        # run — and (b) BullMQ's job-lock renewal — so the lock would lapse, the job stall, and BullMQ
        # REDELIVER it (the workflow runs twice). `to_thread` keeps the loop free for both — and for
        # streaming each step's lifecycle (`publish_step`) so steps show up live, not all at turn-end.
        #
        # While the replay runs the loop is free, so emit a run-scoped liveness beat every few seconds:
        # the engine re-arms its `remoteAdvanceSilenceMs` deadline on each beat and won't wrongly
        # re-drive a slow-but-alive run. Cancel the beat the instant the turn settles (try/finally).
        beat_task = (
            asyncio.create_task(
                _beat_run(beat_client, beat_channel, job.data.get("runId"), group)
            )
            if beat_client is not None
            else None
        )
        try:
            decision = await asyncio.to_thread(
                workflow_worker.process_task, job.data, publish_step, registry.is_cancelled
            )
        finally:
            if beat_task is not None:
                beat_task.cancel()
                try:
                    await beat_task
                except asyncio.CancelledError:
                    pass
        await decisions.add(
            "decision", decision, {"removeOnComplete": True, "removeOnFail": True}
        )
        return decision

    await _start_heartbeat(connection, prefix, group)
    return BullWorker(tasks_name, process, {"connection": connection})


def _step_event_publisher(step_events: Any) -> Callable[[Dict[str, Any]], None]:
    """Build a thread-safe `publish(step_event)` that enqueues each local step's lifecycle onto the
    `<prefix>-step-events` queue from the running loop. `process_task` runs in a worker THREAD (via
    `to_thread`), and the BullMQ queue client is bound to the event loop, so we hop back onto the loop
    via `call_soon_threadsafe`. Best-effort: streaming a step event must never fail the replay."""
    loop = asyncio.get_running_loop()

    def publish(step_event: Dict[str, Any]) -> None:
        async def _send() -> None:
            try:
                await step_events.add(
                    "stepEvent", step_event, {"removeOnComplete": True, "removeOnFail": True}
                )
            except Exception:  # noqa: BLE001 — live step lifecycle is best-effort observability
                pass

        try:
            loop.call_soon_threadsafe(lambda: loop.create_task(_send()))
        except RuntimeError:
            pass  # loop is closing/closed — drop the live event (the final decision still carries it)

    return publish


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
    concurrency: "int | str | dict" = 1,
) -> Any:
    """Start a BullMQ worker that runs ``worker``'s handlers. Returns the bullmq Worker.

    The returned worker runs in the background; ``await worker.close()`` to stop it. When a
    :class:`CancellationRegistry` is given (one is created otherwise), the runner subscribes to the
    control channel and feeds it, so handlers see ``ctx.cancelled``.

    ``concurrency`` accepts an ``int`` (fixed), ``'adaptive'`` (self-tuning with defaults), or a
    config ``dict`` (``min``/``max``/``start``/``ramCeilingPct``/``cpuCeilingPct``/``tickMs``). An
    :class:`AdaptiveController` tracks ``inFlight`` / latency / RSS / CPU for BOTH modes (so the
    heartbeat carries a live ``WorkerStatus``); in adaptive mode it also tunes the live limit.

    UNIFIED: when ``worker`` also holds workflows (``@worker.workflow``), this one runner routes per
    job off the single ``<prefix>-tasks-<group>`` queue — a WORKFLOW task (``is_workflow_task``) is
    replayed and its decision added to ``<prefix>-decisions``; a STEP task runs its handler and the
    result is added to ``<prefix>-results``. The shared concurrency pool counts both in-flight, but the
    adaptive controller measures only STEP completions (``on_settle(..., kind=...)``)."""

    from bullmq import Queue as BullQueue  # imported lazily so the SDK works without bullmq
    from bullmq import Worker as BullWorker

    await _verify_connection(connection)

    tasks_name, results_name = _names(prefix, group)
    results = BullQueue(results_name, {"connection": connection})
    registry = cancellation or CancellationRegistry()
    await _subscribe_control(connection, prefix, registry)
    publish_progress = await _progress_publisher(connection, prefix)

    controller = AdaptiveController(resolve_concurrency(concurrency))

    # Workflow infrastructure — built ONLY when the worker also holds workflows, so a pure step worker
    # keeps exactly its old footprint (no decisions/step-events queue, no run-beat client).
    has_workflows = getattr(worker, "has_workflows", False)
    if has_workflows:
        decisions = BullQueue(f"{prefix}-decisions", {"connection": connection})
        step_events = BullQueue(f"{prefix}-step-events", {"connection": connection})
        publish_step = _step_event_publisher(step_events)
        beat_client = _run_heartbeat_client(connection)
        beat_channel = _run_heartbeat_channel(prefix)

    async def process_workflow(job: Any) -> Any:
        # Mirror run_redis_workflow_worker.process: replay OFF the loop (a turn can run minutes and would
        # block the heartbeat + BullMQ lock renewal → redelivery), beating a run-scoped liveness signal
        # so the engine doesn't wrongly re-drive a slow-but-alive run. Cancel the beat once it settles.
        beat_task = (
            asyncio.create_task(
                _beat_run(beat_client, beat_channel, job.data.get("runId"), group)
            )
            if beat_client is not None
            else None
        )
        try:
            decision = await asyncio.to_thread(
                worker.process_workflow_task, job.data, publish_step, registry.is_cancelled
            )
        finally:
            if beat_task is not None:
                beat_task.cancel()
                try:
                    await beat_task
                except asyncio.CancelledError:
                    pass
        await decisions.add(
            "decision", decision, {"removeOnComplete": True, "removeOnFail": True}
        )
        return decision

    async def process_step(job: Any) -> Any:
        on_event = _make_on_event(job.data, publish_progress) if publish_progress else None
        result = await worker.aprocess_task(
            job.data, is_cancelled=registry.is_cancelled, on_event=on_event
        )
        await results.add("result", result, {"removeOnComplete": True, "removeOnFail": True})
        return result

    async def process(job: Any, _token: str) -> Any:
        # Route per job: a workflow turn vs a step task. Both share the concurrency pool, so the
        # in-flight / settle bracket wraps EITHER — but the controller's measurement window only takes
        # step completions (``kind``), so a fast suspending turn can't corrupt the latency gradient.
        # ``time.monotonic`` (not wall) for a clock-skew-immune duration; ``ok`` reflects the wire
        # status so a failed step counts toward errorRate.
        is_workflow = has_workflows and is_workflow_task(job.data)
        controller.on_start()
        started = time.monotonic()
        ok = False
        try:
            if is_workflow:
                outcome = await process_workflow(job)
                ok = outcome.get("status") != "failed"
            else:
                outcome = await process_step(job)
                ok = outcome.get("status") == "completed"
            return outcome
        finally:
            controller.on_settle(
                (time.monotonic() - started) * 1000.0,
                ok,
                kind="workflow" if is_workflow else "step",
            )

    # Seed BullMQ with the controller's starting limit (fixed N or the adaptive start).
    worker_opts: Dict[str, Any] = {"connection": connection, "concurrency": controller.limit}
    bull_worker = BullWorker(tasks_name, process, worker_opts)

    # The bullmq python port re-reads ``opts['concurrency']`` each scheduling pass, so mutating it
    # applies the controller's decision live (see adaptive.py module docstring).
    def apply_concurrency(new_limit: int) -> None:
        bull_worker.opts["concurrency"] = new_limit

    await _start_heartbeat(connection, prefix, group, controller)
    controller.start(apply_cb=apply_concurrency)
    return bull_worker


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
    No-op (logged) if redis pub/sub isn't available OR the connection/subscribe fails — cancellation
    just won't be observed; it must never block the worker from starting."""
    try:
        import redis.asyncio as aioredis  # lazy: only needed for cooperative cancellation
    except ImportError:
        return

    try:
        client = aioredis.from_url(connection)
        pubsub = client.pubsub()
        await pubsub.subscribe(_control_channel(prefix))
    except Exception as exc:  # noqa: BLE001 — best-effort: a control-channel failure must not break startup
        print(
            f"durable-worker: control-channel subscribe failed ({exc!r}); "
            "cooperative cancellation won't be observed",
            flush=True,
        )
        return

    async def listen() -> None:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                registry.on_control_message(json.loads(message["data"]))
            except (ValueError, TypeError):
                pass  # ignore malformed control messages

    _spawn_retained(listen())
