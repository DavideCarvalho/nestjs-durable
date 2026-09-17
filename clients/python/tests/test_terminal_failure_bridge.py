"""A task job that dies with its worker must come back as a FAILED result, not vanish.

``aprocess_task`` publishes a failed result for every handler error itself, so a task job only ever
reaches BullMQ's terminal ``failed`` state for an INFRASTRUCTURE reason — the process was killed
holding it (an OOM kill) and a peer's stalled-check exhausted ``maxStalledCount``. Nothing then
publishes a result, and the engine's ``pending`` checkpoint has nothing left to settle it: the step is
orphaned and its run waits forever. That is what happened in dev on 2026-09-17 — the TypeScript
transport has bridged this since forever (``worker.on('failed')`` → ``bridgeTaskFailure``) and this
SDK did not, which is exactly why a Python fleet's steps orphan where a Node fleet's do not.

These tests inject a FAKE ``bullmq`` module, so they run without the ``[redis]`` extra installed.
"""

import asyncio
import sys
import unittest
from unittest import mock

from durable_worker import Worker
from durable_worker.redis_runner import (
    _bridge_terminal_failures,
    _failed_step_result,
    _failure_reason,
    _job_data,
)

STEP_TASK = {"runId": "r1", "seq": 3, "stepId": "r1:3", "name": "handle_MVR", "input": {}}


class FailedStepResultTest(unittest.TestCase):
    def test_rebuilds_a_retryable_failed_result_for_a_step_task(self):
        result = _failed_step_result(STEP_TASK, "job stalled more than allowable limit")
        self.assertEqual(result["runId"], "r1")
        self.assertEqual(result["seq"], 3)
        self.assertEqual(result["stepId"], "r1:3")
        self.assertEqual(result["status"], "failed")
        # Retryable: the work is not impossible, the worker that had it is gone — the engine's durable
        # retry decides what happens next.
        self.assertTrue(result["error"]["retryable"])
        self.assertIn("stalled", result["error"]["message"])

    def test_skips_a_workflow_turn(self):
        # A turn is re-driven by the engine's own advance window, not by a step result.
        turn = {"runId": "r1", "seq": 0, "stepId": "r1:0", "workflow": "etl", "history": []}
        self.assertIsNone(_failed_step_result(turn, "boom"))

    def test_skips_a_payload_that_cannot_identify_a_step(self):
        self.assertIsNone(_failed_step_result(None, "boom"))
        self.assertIsNone(_failed_step_result({}, "boom"))
        self.assertIsNone(_failed_step_result({"runId": "r1", "seq": 1}, "boom"))

    def test_skips_a_wrong_typed_payload(self):
        # Presence is not enough (the TS `failedTaskIdentity` checks types too): a garbled job hash
        # must publish NOTHING rather than a result the engine can match to no checkpoint.
        self.assertIsNone(_failed_step_result({**STEP_TASK, "runId": 7}, "boom"))
        self.assertIsNone(_failed_step_result({**STEP_TASK, "stepId": {"a": 1}}, "boom"))
        self.assertIsNone(_failed_step_result({**STEP_TASK, "seq": "3"}, "boom"))
        # `bool` is an `int` subclass in Python — a `True` seq is not a position.
        self.assertIsNone(_failed_step_result({**STEP_TASK, "seq": True}, "boom"))
        # A JSON number that arrived as a float is still a number, as it is in TypeScript.
        self.assertIsNotNone(_failed_step_result({**STEP_TASK, "seq": 3.0}, "boom"))

    def test_reads_the_payload_off_a_job_object_or_a_bare_dict(self):
        job = type("Job", (), {"data": STEP_TASK})()
        self.assertEqual(_job_data(job), STEP_TASK)
        self.assertEqual(_job_data(STEP_TASK), STEP_TASK)
        self.assertIsNone(_job_data(None))

    def test_prefers_bullmqs_own_failedReason(self):
        job = type("Job", (), {"data": STEP_TASK, "failedReason": "stalled"})()
        self.assertEqual(_failure_reason(job, RuntimeError("other")), "stalled")
        self.assertEqual(_failure_reason(None, RuntimeError("other")), "other")
        self.assertEqual(_failure_reason(None, None), "unknown")


class _RecordingResults:
    def __init__(self):
        self.added = []

    async def add(self, name, payload, opts):
        self.added.append((name, payload, opts))


class _EmitterWorker:
    """Fake BullMQ Worker with the emitter API the bridge needs."""

    def __init__(self, *_a, **_k):
        self.listeners = {}
        self.opts = {}

    def on(self, event, handler):
        self.listeners[event] = handler

    async def close(self):
        return None


class BridgeRegistrationTest(unittest.TestCase):
    def test_firing_failed_publishes_the_synthetic_result(self):
        async def scenario():
            results = _RecordingResults()
            bull_worker = _EmitterWorker()
            _bridge_terminal_failures(bull_worker, results)
            job = type("Job", (), {"data": STEP_TASK, "failedReason": "stalled"})()
            bull_worker.listeners["failed"](job, RuntimeError("ignored"))
            await asyncio.sleep(0)  # let the retained publish task run
            return results.added

        added = asyncio.run(scenario())
        self.assertEqual(len(added), 1)
        name, payload, opts = added[0]
        self.assertEqual(name, "result")
        self.assertEqual(payload["stepId"], "r1:3")
        self.assertEqual(payload["status"], "failed")
        self.assertTrue(opts["removeOnComplete"])

    def test_a_workflow_turn_failing_publishes_nothing(self):
        async def scenario():
            results = _RecordingResults()
            bull_worker = _EmitterWorker()
            _bridge_terminal_failures(bull_worker, results)
            turn = {"runId": "r1", "seq": 0, "stepId": "r1:0", "workflow": "etl", "history": []}
            bull_worker.listeners["failed"](turn, "boom")
            await asyncio.sleep(0)
            return results.added

        self.assertEqual(asyncio.run(scenario()), [])

    def test_an_emitterless_worker_is_left_alone(self):
        # An installed bullmq without the emitter API must not break startup — it just gets no bridge.
        class NoEmitter:
            pass

        _bridge_terminal_failures(NoEmitter(), _RecordingResults())  # no raise


class _FakeQueue:
    def __init__(self, name, _opts):
        self.name = name

    async def add(self, *_a, **_k):
        return None


async def _noop(*_a, **_k):
    return None


class RunnerWiresTheBridgeTest(unittest.TestCase):
    """The bridge has to be wired for EVERY per-name BullMQ Worker the runner starts (one queue per
    registered step name since the routing redesign), not just the first."""

    def test_every_per_name_worker_gets_a_failed_listener(self):
        worker = Worker()

        @worker.step("handle_MVR")
        def handle_mvr(_input, _ctx=None):
            return {}

        @worker.step("handle_UTIL")
        def handle_util(_input, _ctx=None):
            return {}

        started = []

        class _TrackingWorker(_EmitterWorker):
            def __init__(self, name, process, opts):
                super().__init__()
                self.name = name
                self.process = process
                self.opts = opts
                started.append(self)

        fake_bullmq = mock.Mock()
        fake_bullmq.Queue = _FakeQueue
        fake_bullmq.Worker = _TrackingWorker

        async def scenario():
            from durable_worker import redis_runner

            with mock.patch.dict(sys.modules, {"bullmq": fake_bullmq}), mock.patch.multiple(
                redis_runner,
                _verify_connection=_noop,
                _start_heartbeat=_noop,
                _subscribe_control=_noop,
                _progress_publisher=_noop,
            ), mock.patch.object(
                redis_runner.AdaptiveController, "start", lambda self, **_k: None
            ):
                return await redis_runner.run_redis_worker(worker)

        handle = asyncio.run(scenario())
        self.assertEqual(len(started), 2)
        for bull_worker in started:
            self.assertIn("failed", bull_worker.listeners)
        self.assertIsNotNone(handle)


if __name__ == "__main__":
    unittest.main()
