"""Regression: the workflow worker must replay OFF the event loop.

`process_task` is synchronous and a real turn can run for minutes; if it ran inline on the loop it
would block the liveness heartbeat (reads as "0 workers" mid-run) and BullMQ's job-lock renewal (the
job stalls and gets REDELIVERED — the workflow runs twice). This drives the real `process` callback
with a blocking `process_task` and asserts a concurrent coroutine keeps making progress.
"""

import asyncio
import time
import unittest
from unittest.mock import patch

from durable_worker.redis_runner import run_redis_workflow_worker


class _FakeQueue:
    def __init__(self, *_a, **_k):
        pass

    async def add(self, *_a, **_k):
        return None


class _FakeWorker:
    def __init__(self, name, process, _opts):
        self.name = name
        self.process = process

    async def close(self):
        pass


class _Job:
    def __init__(self, data):
        self.data = data


class _BlockingWorkflowWorker:
    """process_task blocks (a sync DB-heavy replay) before returning a decision."""

    def __init__(self):
        self.done = False

    def process_task(self, data, on_step=None):
        time.sleep(0.2)
        self.done = True
        return {"runId": data.get("runId"), "status": "completed", "commands": [], "output": {}}


async def _noop(*_a, **_k):
    return None


class WorkflowWorkerOffloadTest(unittest.IsolatedAsyncioTestCase):
    async def test_process_task_runs_off_the_event_loop(self):
        wf = _BlockingWorkflowWorker()
        with patch("bullmq.Queue", _FakeQueue), patch("bullmq.Worker", _FakeWorker), patch(
            "durable_worker.redis_runner._verify_connection", _noop
        ), patch("durable_worker.redis_runner._start_heartbeat", _noop):
            worker = await run_redis_workflow_worker(
                wf, group="g", connection="redis://localhost:6379", prefix="durable"
            )

        # A concurrent coroutine standing in for the heartbeat / lock-renewal loop. If process_task
        # blocked the loop, this would not tick until it returned.
        ticks = 0

        async def ticker():
            nonlocal ticks
            while not wf.done:
                ticks += 1
                await asyncio.sleep(0.01)

        tick_task = asyncio.create_task(ticker())
        await worker.process(_Job({"runId": "r1"}), "token")
        await tick_task

        self.assertTrue(wf.done)
        self.assertGreater(ticks, 1)  # the loop kept running during the blocking replay


if __name__ == "__main__":
    unittest.main()
