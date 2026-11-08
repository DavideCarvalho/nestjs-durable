"""How a step worker sends its results back — the same wire behaviour as the TypeScript
``BullMQTransport`` (``publishResult`` / ``publishReply``), so a Python fleet costs an engine no more
than a Node one.

Three destinations, picked per result:

1. **Routed reply.** A task stamped ``replyTo`` (an engine instance id) holds its workflow body parked
   in that instance's memory. While the instance's alive key ``<prefix>:reply-alive:<id>`` exists, the
   result goes to ``<prefix>-results-to-<id>``, a queue only that instance consumes — so it resumes
   the parked body instead of another engine replaying it. Liveness is read at most once a second per
   instance. A result that can't be routed (instance gone, Redis refusing) falls through to 2/3.
2. **Result batches.** While some engine consumes ``<prefix>-results-batch`` (a BullMQ worker on it,
   read from ``CLIENT LIST`` at most every 5 s), results that finish while one batch is being
   published go out together in the next — one job per batch instead of one per step under load,
   and still one job right away when idle. A batch that fails to publish goes out one job per result.
3. **Shared results.** ``<prefix>-results``, one job per result: an engine that predates batches, or
   a Redis that refuses ``CLIENT LIST``.

Older engines ignore ``replyTo`` and never consume the batch queue, so this stays wire-compatible.
"""

from __future__ import annotations

import asyncio
import base64
import re
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

# Same as the TypeScript RESULT_JOB_OPTIONS (the engine retries a result job it failed to apply).
RESULT_JOB_OPTIONS: Dict[str, Any] = {
    "attempts": 5,
    "backoff": {"type": "exponential", "delay": 500},
    "removeOnComplete": True,
    "removeOnFail": True,
}
RESULT_BATCH_MAX = 256
_BATCH_CONSUMERS_TTL_S = 5.0
_REPLY_ALIVE_TTL_S = 1.0
_QUEUE_TOKEN = re.compile(r"[^A-Za-z0-9_.@-]")


def reply_queue_name(prefix: str, instance_id: str) -> str:
    """``<prefix>-results-to-<id>``, sanitized byte-identically to the TypeScript transport."""
    return f"{prefix}-results-to-{_QUEUE_TOKEN.sub('-', instance_id)}"


def reply_alive_key(prefix: str, instance_id: str) -> str:
    return f"{prefix}:reply-alive:{instance_id}"


def bullmq_client_name(queue_name: str, redis_prefix: str = "bull") -> str:
    """The connection name a BullMQ worker on ``queue_name`` sets (``CLIENT SETNAME``)."""
    return f"{redis_prefix}:{base64.b64encode(queue_name.encode()).decode()}"


def count_queue_workers(client_list: str, queue_name: str) -> int:
    """How many connections in a ``CLIENT LIST`` reply are BullMQ workers on ``queue_name`` — the same
    matcher as BullMQ's ``Queue.getWorkersCount``."""
    unnamed = bullmq_client_name(queue_name)
    named = unnamed + ":w:"
    count = 0
    for line in client_list.splitlines():
        for field in line.split(" "):
            if field.startswith("name="):
                name = field[5:]
                if name == unnamed or name.startswith(named):
                    count += 1
                break
    return count


class _Outbox:
    __slots__ = ("entries", "publishing")

    def __init__(self) -> None:
        self.entries: List[Tuple[Dict[str, Any], "asyncio.Future[bool]"]] = []
        self.publishing = False


class ResultPublisher:
    """Sends step results to the right queue (see the module docstring). One per runner/event loop.

    ``queue_factory(name)`` returns a BullMQ ``Queue``-like object with ``async add(name, data,
    opts)``; ``redis`` is an ``redis.asyncio`` client (or ``None`` to disable routing and batching,
    e.g. when the package is missing)."""

    def __init__(
        self,
        prefix: str,
        queue_factory: Callable[[str], Any],
        redis: Any = None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._prefix = prefix
        self._queue_factory = queue_factory
        self._queues: Dict[str, Any] = {}
        self._redis = redis
        self._clock = clock
        self._results_name = f"{prefix}-results"
        self._batches_name = f"{prefix}-results-batch"
        self._batch_consumers: Optional[Tuple[bool, float]] = None
        self._batch_consumers_read: Optional["asyncio.Future[bool]"] = None
        self._alive: Dict[str, Tuple[bool, float]] = {}
        self._outboxes: Dict[str, _Outbox] = {}

    def queue(self, name: str) -> Any:
        q = self._queues.get(name)
        if q is None:
            q = self._queue_factory(name)
            self._queues[name] = q
        return q

    async def close(self) -> None:
        """Close the queues this publisher opened and its routing Redis client. Best effort: call
        it once the workers publishing through it have stopped."""
        queues, self._queues = list(self._queues.values()), {}
        redis, self._redis = self._redis, None
        for closeable in [*queues, redis]:
            closer = getattr(closeable, "aclose", None) or getattr(closeable, "close", None)
            if closer is None:
                continue
            try:
                await closer()
            except Exception:  # noqa: BLE001 — teardown is best-effort
                pass

    async def publish(self, result: Dict[str, Any], reply_to: Optional[str] = None) -> None:
        if isinstance(reply_to, str) and reply_to and await self._publish_reply(result, reply_to):
            return
        if await self._batches_consumed() and await self._enqueue(self._batches_name, result):
            return
        await self.queue(self._results_name).add("result", result, RESULT_JOB_OPTIONS)

    # --- routed replies -------------------------------------------------------------------------

    async def _reply_alive(self, instance_id: str) -> bool:
        known = self._alive.get(instance_id)
        now = self._clock()
        if known is not None and now - known[1] < _REPLY_ALIVE_TTL_S:
            return known[0]
        try:
            alive = int(await self._redis.exists(reply_alive_key(self._prefix, instance_id))) == 1
        except Exception:  # noqa: BLE001 — unknown liveness: use the shared results
            alive = False
        self._alive[instance_id] = (alive, self._clock())
        return alive

    async def _publish_reply(self, result: Dict[str, Any], reply_to: str) -> bool:
        if self._redis is None or not await self._reply_alive(reply_to):
            return False
        return await self._enqueue(reply_queue_name(self._prefix, reply_to), result)

    # --- batching -------------------------------------------------------------------------------

    async def _batches_consumed(self) -> bool:
        if self._redis is None:
            return False
        known = self._batch_consumers
        if known is not None and self._clock() - known[1] < _BATCH_CONSUMERS_TTL_S:
            return known[0]
        if self._batch_consumers_read is None:
            self._batch_consumers_read = asyncio.ensure_future(self._read_batch_consumers())
        return await asyncio.shield(self._batch_consumers_read)

    async def _read_batch_consumers(self) -> bool:
        try:
            raw = await self._redis.execute_command("CLIENT", "LIST")
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", "replace")
            elif not isinstance(raw, str):
                # redis-py parses CLIENT LIST into a list of dicts.
                raw = "\n".join(
                    " ".join(f"{k}={v}" for k, v in entry.items()) for entry in raw or []
                )
            consumed = count_queue_workers(raw, self._batches_name) > 0
        except Exception:  # noqa: BLE001 — a refused/failed read answers no: one job per result
            consumed = False
        self._batch_consumers = (consumed, self._clock())
        self._batch_consumers_read = None
        return consumed

    async def _enqueue(self, queue_name: str, result: Dict[str, Any]) -> bool:
        """Queue ``result`` on ``queue_name``'s outbox; resolves once it is published (True) or the
        batch carrying it failed (False — the caller falls back)."""
        outbox = self._outboxes.get(queue_name)
        if outbox is None:
            outbox = _Outbox()
            self._outboxes[queue_name] = outbox
        fut: "asyncio.Future[bool]" = asyncio.get_running_loop().create_future()
        outbox.entries.append((result, fut))
        if not outbox.publishing:
            outbox.publishing = True
            asyncio.ensure_future(self._drain(queue_name, outbox))
        return await fut

    async def _drain(self, queue_name: str, outbox: _Outbox) -> None:
        try:
            while outbox.entries:
                batch = outbox.entries[:RESULT_BATCH_MAX]
                del outbox.entries[:RESULT_BATCH_MAX]
                try:
                    # The batch queue's consumer reads only `{results}`; a reply queue takes both.
                    if len(batch) == 1 and queue_name != self._batches_name:
                        await self.queue(queue_name).add("result", batch[0][0], RESULT_JOB_OPTIONS)
                    else:
                        await self.queue(queue_name).add(
                            "results", {"results": [r for r, _ in batch]}, RESULT_JOB_OPTIONS
                        )
                    sent = True
                except Exception:  # noqa: BLE001 — each caller falls back on its own
                    sent = False
                for _, fut in batch:
                    if not fut.done():
                        fut.set_result(sent)
        finally:
            outbox.publishing = False
            for _, fut in outbox.entries:  # only if the loop died mid-drain
                if not fut.done():
                    fut.set_result(False)
            outbox.entries.clear()
