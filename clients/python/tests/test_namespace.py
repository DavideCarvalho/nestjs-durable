"""Namespace -> transport partitioning (Python worker side).

A logical deployment ``namespace`` segments every BullMQ queue / pub-sub channel / liveness key a
worker touches, so the same Redis can host multiple isolated deployments without crosstalk. The
derivation MUST be byte-identical to the TypeScript ``BullMQTransport``'s ``#effectivePrefix()`` —
this is a cross-SDK contract: a namespaced engine and a namespaced worker have to meet on the SAME
names. ``"default"`` (or unset) keeps every name byte-identical to the un-namespaced scheme, so an
already-deployed worker is unaffected.
"""

import asyncio
import unittest
from unittest.mock import patch

from durable_worker import Worker, run_workers
from durable_worker.redis_runner import (
    _control_channel,
    _effective_prefix,
    _heartbeat_key,
    _names,
    _run_heartbeat_channel,
    run_redis_worker,
    run_redis_workflow_worker,
)
from durable_worker.workflow import WorkflowWorker


class EffectivePrefixTest(unittest.TestCase):
    """The cross-SDK naming rule: bare prefix for unset/``default``, ``-<namespace>`` otherwise."""

    def test_default_namespace_is_byte_identical_to_bare_prefix(self):
        self.assertEqual(_effective_prefix("durable", "default"), "durable")

    def test_none_namespace_is_byte_identical_to_bare_prefix(self):
        self.assertEqual(_effective_prefix("durable", None), "durable")

    def test_empty_namespace_is_byte_identical_to_bare_prefix(self):
        # A falsy ("") namespace is treated as unset — never produces a dangling "durable-".
        self.assertEqual(_effective_prefix("durable", ""), "durable")

    def test_non_default_namespace_is_segmented(self):
        self.assertEqual(_effective_prefix("durable", "dev-alice"), "durable-dev-alice")

    def test_segments_a_custom_prefix_too(self):
        self.assertEqual(_effective_prefix("flip", "dev-alice"), "flip-dev-alice")

    def test_helper_drives_every_name_builder_when_passed_the_effective_prefix(self):
        # The runners compute the effective prefix once and thread it through these builders, so the
        # whole keyspace stays segmented and consistent for namespace ``dev-alice``.
        eff = _effective_prefix("durable", "dev-alice")
        self.assertEqual(_names(eff, "processing"),
                         ("durable-dev-alice-tasks-processing", "durable-dev-alice-results"))
        self.assertEqual(_control_channel(eff), "durable-dev-alice-control")
        self.assertEqual(_run_heartbeat_channel(eff), "durable-dev-alice-heartbeat")
        self.assertTrue(
            _heartbeat_key(eff, "processing").startswith(
                "durable-dev-alice-worker-heartbeat:processing:"
            )
        )


class _RecordingQueue:
    """Fake BullMQ Queue: records the queue name it was constructed with."""

    created_names: list = []

    def __init__(self, name, _opts):
        _RecordingQueue.created_names.append(name)
        self.name = name

    async def add(self, *_a, **_k):
        return None


class _RecordingWorker:
    """Fake BullMQ Worker: records the (task) queue name it consumes."""

    created_names: list = []

    def __init__(self, name, process, _opts):
        _RecordingWorker.created_names.append(name)
        self.name = name
        self.process = process
        self.opts = _opts

    async def close(self):
        return None


async def _noop(*_a, **_k):
    return None


def _reset_recorders():
    _RecordingQueue.created_names = []
    _RecordingWorker.created_names = []


class _RunnerNamePatches:
    """Patch out the transport side-effects so we can drive the real runners and inspect names."""

    def __enter__(self):
        self._patches = [
            patch("bullmq.Queue", _RecordingQueue),
            patch("bullmq.Worker", _RecordingWorker),
            patch("durable_worker.redis_runner._verify_connection", _noop),
            patch("durable_worker.redis_runner._start_heartbeat", _noop),
            patch("durable_worker.redis_runner._subscribe_control", _noop),
            patch("durable_worker.redis_runner._progress_publisher", _noop),
            # Don't spawn the adaptive control loop — we only care about the names built before return.
            patch("durable_worker.redis_runner.AdaptiveController.start", lambda self, **_k: None),
        ]
        for p in self._patches:
            p.start()
        _reset_recorders()
        return self

    def __exit__(self, *_exc):
        for p in self._patches:
            p.stop()
        return False


class StepRunnerNamespaceTest(unittest.IsolatedAsyncioTestCase):
    async def test_namespace_segments_the_step_queue_names(self):
        worker = Worker("processing", namespace="dev-alice", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker,
                group="processing",
                connection="redis://localhost:6379",
                namespace=worker.namespace,
            )

        self.assertIn("durable-dev-alice-results", _RecordingQueue.created_names)
        self.assertIn("durable-dev-alice-tasks-processing", _RecordingWorker.created_names)

    async def test_default_namespace_keeps_names_unchanged(self):
        worker = Worker("processing", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, group="processing", connection="redis://localhost:6379"
            )

        self.assertIn("durable-results", _RecordingQueue.created_names)
        self.assertIn("durable-tasks-processing", _RecordingWorker.created_names)
        # The segmented form is NOT used on the default path.
        self.assertNotIn("durable-default-results", _RecordingQueue.created_names)


class WorkflowRunnerNamespaceTest(unittest.IsolatedAsyncioTestCase):
    async def test_namespace_segments_decisions_step_events_and_task_queue(self):
        wf = WorkflowWorker("py-workflows", namespace="dev-alice", auto_register=False)

        @wf.workflow("pipeline")
        def pipeline(_ctx):
            return None

        with _RunnerNamePatches():
            await run_redis_workflow_worker(
                wf,
                group="py-workflows",
                connection="redis://localhost:6379",
                namespace=wf.namespace,
            )

        self.assertIn("durable-dev-alice-decisions", _RecordingQueue.created_names)
        self.assertIn("durable-dev-alice-step-events", _RecordingQueue.created_names)
        self.assertIn("durable-dev-alice-tasks-py-workflows", _RecordingWorker.created_names)


class RunWorkersNamespaceTest(unittest.TestCase):
    """``run_workers`` forwards its namespace to the per-worker runner, and an explicit per-worker
    namespace wins over the one passed to ``run_workers`` (mirrors the TS explicit-wins rule).

    ``run_workers`` owns its own ``asyncio.run`` loop, so this is a plain (sync) TestCase — patching
    ``asyncio.Event.wait`` to return instantly lets ``_main`` exit right after the startup sequence."""

    def _capture_namespaces(self, workers, *, run_namespace):
        seen = []

        async def fake_step(worker, *, group, connection, prefix, namespace="default", **_):
            seen.append(("step", group, namespace))
            return _FakeHandle()

        async def fake_wf(worker, *, group, connection, prefix, namespace="default", **_):
            seen.append(("workflow", group, namespace))
            return _FakeHandle()

        async def _instant_wait(_self):
            return

        with patch(
            "durable_worker.redis_runner.run_redis_worker", side_effect=fake_step
        ), patch(
            "durable_worker.redis_runner.run_redis_workflow_worker", side_effect=fake_wf
        ), patch.object(asyncio.Event, "wait", _instant_wait):
            run_workers(workers, namespace=run_namespace)
        return seen

    def test_run_workers_namespace_applies_to_workers_without_their_own(self):
        worker = Worker("processing", auto_register=False)
        seen = self._capture_namespaces([worker], run_namespace="dev-bob")
        self.assertEqual(seen, [("step", "processing", "dev-bob")])

    def test_explicit_worker_namespace_wins_over_run_workers_namespace(self):
        worker = Worker("processing", namespace="dev-alice", auto_register=False)
        seen = self._capture_namespaces([worker], run_namespace="dev-bob")
        self.assertEqual(seen, [("step", "processing", "dev-alice")])


class _FakeHandle:
    async def close(self):
        return None


if __name__ == "__main__":
    unittest.main()
