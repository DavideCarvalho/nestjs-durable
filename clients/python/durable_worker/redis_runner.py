"""Run a :class:`Worker` against the BullMQ/Redis transport.

Consumes the orchestrator's per-group tasks queue and publishes results on the shared results
queue — the same queues a TypeScript ``BullMQTransport`` uses, so steps interoperate across
languages. Requires the optional ``bullmq`` extra: ``pip install durable-worker[redis]``.
"""

from __future__ import annotations

from typing import Any

from .worker import Worker


def _names(prefix: str, group: str) -> tuple[str, str]:
    # Must match the TS BullMQTransport: '<prefix>-tasks-<group>' and '<prefix>-results'.
    return f"{prefix}-tasks-{group}", f"{prefix}-results"


async def run_redis_worker(
    worker: Worker,
    *,
    group: str,
    connection: str = "redis://localhost:6379",
    prefix: str = "durable",
) -> Any:
    """Start a BullMQ worker that runs ``worker``'s handlers. Returns the bullmq Worker.

    The returned worker runs in the background; ``await worker.close()`` to stop it.
    """

    from bullmq import Queue as BullQueue  # imported lazily so the SDK works without bullmq
    from bullmq import Worker as BullWorker

    tasks_name, results_name = _names(prefix, group)
    results = BullQueue(results_name, {"connection": connection})

    async def process(job: Any, _token: str) -> None:
        result = await worker.aprocess_task(job.data)
        await results.add("result", result, {"removeOnComplete": True, "removeOnFail": True})

    return BullWorker(tasks_name, process, {"connection": connection})
