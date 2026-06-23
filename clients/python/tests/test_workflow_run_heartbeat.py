"""Per-run liveness heartbeat during a workflow turn.

While `process_task` replays a turn (off-loop in `to_thread`), the worker must EMIT a run-scoped
beat on `<prefix>-heartbeat` immediately and then every 5s, so the TS engine's
`remoteAdvanceSilenceMs` deadline keeps re-arming and a slow-but-alive worker is never wrongly
re-driven. The beat is cancelled the instant the turn settles (try/finally), and a failed publish
must never break the turn.

These tests drive the pure helper `_beat_run` with a fake async redis client and assert the wire
contract: channel `<prefix>-heartbeat`, payload `{runId, seq: 0, group}` (no stepId).
"""

import asyncio
import json
import unittest

from durable_worker.redis_runner import _BEAT_INTERVAL_SECONDS, _beat_run, _run_heartbeat_channel


class FakeAsyncRedis:
    """Records publish(channel, payload) calls; can be told to raise."""

    def __init__(self, *, publish_error: Exception | None = None):
        self._publish_error = publish_error
        self.publishes: list[tuple[str, str]] = []

    async def publish(self, channel, payload):
        self.publishes.append((channel, payload))
        if self._publish_error is not None:
            raise self._publish_error
        return 1


class RunHeartbeatChannelTest(unittest.TestCase):
    def test_channel_matches_wire_contract(self):
        self.assertEqual(_run_heartbeat_channel("durable"), "durable-heartbeat")


class BeatRunTest(unittest.IsolatedAsyncioTestCase):
    async def test_beats_immediately_with_run_scoped_payload(self):
        client = FakeAsyncRedis()
        channel = _run_heartbeat_channel("durable")
        task = asyncio.create_task(_beat_run(client, channel, "run-1", "g"))
        # Yield enough for the immediate beat to land before the 5s sleep.
        for _ in range(10):
            await asyncio.sleep(0)
            if client.publishes:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        self.assertTrue(client.publishes, "should beat immediately when the turn starts")
        ch, raw = client.publishes[0]
        self.assertEqual(ch, "durable-heartbeat")
        payload = json.loads(raw)
        self.assertEqual(payload["runId"], "run-1")
        self.assertEqual(payload["seq"], 0)
        self.assertEqual(payload["group"], "g")
        self.assertNotIn("stepId", payload)  # run-scoped beat OMITS stepId

    async def test_cancellation_stops_the_beat(self):
        client = FakeAsyncRedis()
        task = asyncio.create_task(_beat_run(client, "durable-heartbeat", "run-1", "g"))
        for _ in range(10):
            await asyncio.sleep(0)
            if client.publishes:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        self.assertTrue(task.done())
        count_after_cancel = len(client.publishes)
        # No further beats once cancelled.
        for _ in range(5):
            await asyncio.sleep(0)
        self.assertEqual(len(client.publishes), count_after_cancel)

    async def test_failed_publish_does_not_raise(self):
        client = FakeAsyncRedis(publish_error=RuntimeError("redis down"))
        task = asyncio.create_task(_beat_run(client, "durable-heartbeat", "run-1", "g"))
        for _ in range(10):
            await asyncio.sleep(0)
            if client.publishes:
                break
        # The beat attempted a publish (which raised) but the task is still alive, not failed.
        self.assertTrue(client.publishes)
        self.assertFalse(task.done())
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def test_interval_is_five_seconds(self):
        self.assertEqual(_BEAT_INTERVAL_SECONDS, 5)


class ProcessCallbackBeatsTest(unittest.IsolatedAsyncioTestCase):
    """End-to-end at the `process` callback: a beat is published while the turn is in flight and the
    beat task is gone once the decision is returned — and a failing publisher still yields a decision.
    """

    async def test_process_beats_during_turn_and_stops_after_settle(self):
        import time
        from unittest.mock import patch

        from durable_worker.redis_runner import run_redis_workflow_worker

        client = FakeAsyncRedis()

        class _FakeQueue:
            def __init__(self, *_a, **_k):
                pass

            async def add(self, *_a, **_k):
                return None

        class _FakeWorker:
            def __init__(self, name, process, _opts):
                self.process = process

            async def close(self):
                pass

        class _Job:
            def __init__(self, data):
                self.data = data

        class _SlowWorkflowWorker:
            def process_task(self, data, on_step=None, is_cancelled=None):
                time.sleep(0.1)
                return {"runId": data.get("runId"), "status": "completed", "commands": []}

        async def _noop(*_a, **_k):
            return None

        with patch("bullmq.Queue", _FakeQueue), patch("bullmq.Worker", _FakeWorker), patch(
            "durable_worker.redis_runner._verify_connection", _noop
        ), patch("durable_worker.redis_runner._start_heartbeat", _noop), patch(
            "durable_worker.redis_runner._subscribe_control", _noop
        ), patch(
            "durable_worker.redis_runner._run_heartbeat_client", return_value=client
        ):
            worker = await run_redis_workflow_worker(
                _SlowWorkflowWorker(), group="g", connection="redis://x", prefix="durable"
            )

        decision_holder = {}

        async def drive():
            decision_holder["decision"] = await worker.process(_Job({"runId": "r1"}), "tok")

        await drive()

        # At least one run-scoped beat landed during the turn.
        self.assertTrue(client.publishes)
        ch, raw = client.publishes[0]
        self.assertEqual(ch, "durable-heartbeat")
        payload = json.loads(raw)
        self.assertEqual(payload["runId"], "r1")
        self.assertEqual(payload["seq"], 0)
        self.assertEqual(payload["group"], "g")

        # After settle, no new beats accrue.
        settled = len(client.publishes)
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(len(client.publishes), settled)

    async def test_failing_publisher_still_returns_decision(self):
        import time
        from unittest.mock import patch

        from durable_worker.redis_runner import run_redis_workflow_worker

        client = FakeAsyncRedis(publish_error=RuntimeError("redis down"))

        class _FakeQueue:
            def __init__(self, *_a, **_k):
                pass

            async def add(self, *_a, **_k):
                return None

        class _FakeWorker:
            def __init__(self, name, process, _opts):
                self.process = process

        class _Job:
            def __init__(self, data):
                self.data = data

        class _SlowWorkflowWorker:
            def process_task(self, data, on_step=None, is_cancelled=None):
                time.sleep(0.05)
                return {"runId": data.get("runId"), "status": "completed", "commands": []}

        async def _noop(*_a, **_k):
            return None

        with patch("bullmq.Queue", _FakeQueue), patch("bullmq.Worker", _FakeWorker), patch(
            "durable_worker.redis_runner._verify_connection", _noop
        ), patch("durable_worker.redis_runner._start_heartbeat", _noop), patch(
            "durable_worker.redis_runner._subscribe_control", _noop
        ), patch(
            "durable_worker.redis_runner._run_heartbeat_client", return_value=client
        ):
            worker = await run_redis_workflow_worker(
                _SlowWorkflowWorker(), group="g", connection="redis://x", prefix="durable"
            )

        result = await worker.process(_Job({"runId": "r1"}), "tok")
        self.assertEqual(result["runId"], "r1")
        self.assertTrue(client.publishes)  # it tried


if __name__ == "__main__":
    unittest.main()
