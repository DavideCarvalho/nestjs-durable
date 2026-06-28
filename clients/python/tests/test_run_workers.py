"""Tests for run_workers — verifies dispatch routing and graceful close without a real Redis.

run_workers does `from .redis_runner import run_redis_worker, run_redis_workflow_worker`
inside _main() at call time, so we patch on `durable_worker.redis_runner` (the source module)
rather than on `durable_worker.worker`.  asyncio.Event.wait is replaced with an instant-return
coroutine so _main() exits right after the startup sequence, letting us inspect what was called.
"""

import asyncio
import unittest
from unittest.mock import patch

from durable_worker import Worker, run_workers
from durable_worker.workflow import WorkflowWorker


class _FakeHandle:
    """Fake BullMQ worker handle: records whether close() was called."""

    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


def _make_fake_runner(handle, calls, kind):
    """Return an async fake runner that appends (kind, worker, group) to *calls*.

    Accepts ``**_`` so it tolerates the extra keyword args run_workers forwards to the real runners
    (e.g. ``concurrency`` to the step runner) without each addition breaking the dispatch tests."""

    async def runner(worker, *, group, connection, prefix, **_):
        calls.append((kind, worker, group))
        return handle

    return runner


async def _instant_wait(self):
    """Replacement for asyncio.Event.wait that returns immediately."""
    return


class RunWorkersDispatchTest(unittest.TestCase):
    """Verifies run_workers routes each worker to the correct runner and closes all handles."""

    def _run(self, workers, step_handle, wf_handle):
        """Drive run_workers with patched runners and an auto-stopping event."""
        calls = []
        fake_step = _make_fake_runner(step_handle, calls, "step")
        fake_wf = _make_fake_runner(wf_handle, calls, "workflow")

        with patch(
            "durable_worker.redis_runner.run_redis_worker",
            side_effect=fake_step,
        ), patch(
            "durable_worker.redis_runner.run_redis_workflow_worker",
            side_effect=fake_wf,
        ), patch.object(asyncio.Event, "wait", _instant_wait):
            run_workers(workers, redis="redis://localhost:6379", prefix="durable")

        return calls

    def test_step_worker_uses_run_redis_worker(self):
        step_worker = Worker(group="a")
        step_handle = _FakeHandle()

        calls = self._run([step_worker], step_handle, _FakeHandle())

        self.assertEqual(len(calls), 1)
        kind, worker, group = calls[0]
        self.assertEqual(kind, "step")
        self.assertIs(worker, step_worker)
        self.assertEqual(group, "a")

    def test_workflow_worker_uses_run_redis_workflow_worker(self):
        wf_worker = WorkflowWorker(group="b")
        wf_handle = _FakeHandle()

        calls = self._run([wf_worker], _FakeHandle(), wf_handle)

        self.assertEqual(len(calls), 1)
        kind, worker, group = calls[0]
        self.assertEqual(kind, "workflow")
        self.assertIs(worker, wf_worker)
        self.assertEqual(group, "b")

    def test_mixed_workers_dispatch_to_correct_runners(self):
        step_worker = Worker(group="a")
        wf_worker = WorkflowWorker(group="b")
        step_handle = _FakeHandle()
        wf_handle = _FakeHandle()

        calls = self._run([step_worker, wf_worker], step_handle, wf_handle)

        self.assertEqual(len(calls), 2)

        step_calls = [(k, g) for k, _w, g in calls if k == "step"]
        wf_calls = [(k, g) for k, _w, g in calls if k == "workflow"]

        self.assertEqual(step_calls, [("step", "a")])
        self.assertEqual(wf_calls, [("workflow", "b")])

    def test_all_handles_are_closed_on_shutdown(self):
        step_worker = Worker(group="a")
        wf_worker = WorkflowWorker(group="b")
        step_handle = _FakeHandle()
        wf_handle = _FakeHandle()

        self._run([step_worker, wf_worker], step_handle, wf_handle)

        self.assertTrue(step_handle.closed, "step handle should be closed on shutdown")
        self.assertTrue(wf_handle.closed, "workflow handle should be closed on shutdown")

    def test_empty_workers_list_runs_without_error(self):
        """run_workers([]) should start and stop cleanly — no handles, nothing to close."""
        with patch.object(asyncio.Event, "wait", _instant_wait):
            # No runners to patch; should not raise.
            run_workers([], redis="redis://localhost:6379", prefix="durable")

    def test_correct_group_is_forwarded_to_runner(self):
        """The group forwarded to the runner must come from worker.group, not a default."""
        step_worker = Worker(group="custom-group")
        step_handle = _FakeHandle()

        calls = self._run([step_worker], step_handle, _FakeHandle())

        _, _, group = calls[0]
        self.assertEqual(group, "custom-group")


if __name__ == "__main__":
    unittest.main()
