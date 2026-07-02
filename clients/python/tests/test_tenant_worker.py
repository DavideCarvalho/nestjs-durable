"""P4C.3 (tenant field) + Task 8 (partition-routed per-name queues) — Python worker side.

Two distinct concerns share this file:

1. ``Worker.tenant`` — a DATA LABEL stamped verbatim on ``StartRunMessage.tenant`` by ``start_run``
   (falls back to ``self.namespace`` when unset). Decoupled from the wire: it never touches the
   transport prefix or a queue name.

2. ``partition`` — the WIRE-level isolation suffix for THIS worker's queue routing. The OLD Python
   model had TWO axes: ``group`` (base queue) and ``tenant`` (isolation suffix, via ``_tenant_group``).
   The redesign ELIMINATES the base (it is now the handler name) and RENAMES the suffix to
   ``partition``. Routing moved from "one shared group queue" to "one queue PER registered
   handler/workflow name": ``run_redis_worker`` starts one BullMQ Worker per name in ``worker.names``,
   each on ``f"{prefix}-tasks-{tenant_group(sanitize_queue_token(name), partition)}"``.

       - ``sanitize_queue_token(name) = name.replace(':', '-')`` — BullMQ forbids ``:`` in a queue
         name; must byte-match the TypeScript ``sanitizeQueueToken``.
       - ``tenant_group(base, partition)`` is the byte-identical Python mirror of the TypeScript
         ``tenantGroup``: ``None``/``''``/``'default'`` -> the bare ``base``; any other partition ->
         ``"<base>@<partition>"``.
       - ``Worker(tenant=...)`` is the deprecated ROUTING alias — it maps to ``partition`` so a
         worker built the old way still subscribes to ``<handler>@<tenant>`` queues.
       - ``Worker(group=...)`` is deprecated and IGNORED for routing (the base is the handler name).
"""

import unittest
import warnings
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from durable_worker import Worker
from durable_worker.redis_runner import _tenant_group, run_redis_worker, sanitize_queue_token


# ---------------------------------------------------------------------------
# sanitize_queue_token — cross-SDK conformance (byte-identical to JS sanitizeQueueToken)
# ---------------------------------------------------------------------------


class SanitizeQueueTokenTest(unittest.TestCase):
    def test_replaces_colon_with_dash(self):
        self.assertEqual(sanitize_queue_token("extraction:page"), "extraction-page")

    def test_leaves_dot_as_is(self):
        self.assertEqual(sanitize_queue_token("payments.charge"), "payments.charge")

    def test_replaces_every_colon(self):
        self.assertEqual(sanitize_queue_token("a:b:c"), "a-b-c")


# ---------------------------------------------------------------------------
# _tenant_group — cross-SDK conformance (byte-identical to TS tenantGroup)
# ---------------------------------------------------------------------------


class TenantGroupTest(unittest.TestCase):
    def test_real_partition_suffixes_the_base(self):
        self.assertEqual(_tenant_group("processing", "davi-local"), "processing@davi-local")

    def test_none_partition_is_bare_base(self):
        self.assertEqual(_tenant_group("processing", None), "processing")

    def test_empty_string_partition_is_bare_base(self):
        self.assertEqual(_tenant_group("processing", ""), "processing")

    def test_default_partition_is_bare_base(self):
        self.assertEqual(_tenant_group("processing", "default"), "processing")


# ---------------------------------------------------------------------------
# Deprecated constructor aliases: tenant= -> partition (routing); group= ignored
# ---------------------------------------------------------------------------


class WorkerDeprecatedAliasTest(unittest.TestCase):
    def test_tenant_kwarg_maps_to_partition_and_warns(self):
        # tenant= is the RENAMED suffix axis — it must set partition (the routing suffix).
        with self.assertWarns(DeprecationWarning):
            worker = Worker(tenant="davi-local", auto_register=False)
        self.assertEqual(worker.partition, "davi-local")
        # ...and Worker.tenant still reflects it for StartRunMessage stamping.
        self.assertEqual(worker.tenant, "davi-local")

    def test_explicit_partition_wins_over_tenant_alias(self):
        with self.assertWarns(DeprecationWarning):
            worker = Worker(partition="explicit", tenant="ignored", auto_register=False)
        self.assertEqual(worker.partition, "explicit")

    def test_group_kwarg_is_ignored_for_routing_and_warns(self):
        # group= is the ELIMINATED base axis — accepted, warned, but NEVER a routing suffix.
        with self.assertWarns(DeprecationWarning):
            worker = Worker(group="processing", auto_register=False)
        self.assertIsNone(worker.partition)

    def test_partition_is_silent(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            worker = Worker(partition="processing", auto_register=False)
        self.assertEqual(worker.partition, "processing")
        # Partition doubles as the tenant label when no separate tenant is given.
        self.assertEqual(worker.tenant, "processing")


# ---------------------------------------------------------------------------
# run_redis_worker — one BullMQ Worker PER registered name, partition-suffixed
# ---------------------------------------------------------------------------


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


class _RecordingHeartbeat:
    """Captures the (prefix, group) pair _start_heartbeat was called with, once per registered name."""

    calls: list = []

    async def __call__(self, connection, prefix, group, controller=None):
        _RecordingHeartbeat.calls.append({"prefix": prefix, "group": group})


async def _noop(*_a, **_k):
    return None


def _reset_recorders():
    _RecordingQueue.created_names = []
    _RecordingWorker.created_names = []
    _RecordingHeartbeat.calls = []


class _RunnerNamePatches:
    """Patch out the transport side-effects so we can drive the real runner and inspect names."""

    def __enter__(self):
        self._patches = [
            patch("bullmq.Queue", _RecordingQueue),
            patch("bullmq.Worker", _RecordingWorker),
            patch("durable_worker.redis_runner._verify_connection", _noop),
            patch("durable_worker.redis_runner._start_heartbeat", _RecordingHeartbeat()),
            patch("durable_worker.redis_runner._subscribe_control", _noop),
            patch("durable_worker.redis_runner._progress_publisher", _noop),
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


class RunRedisWorkerPerNameQueueTest(unittest.IsolatedAsyncioTestCase):
    async def test_partition_creates_one_queue_per_registered_name(self):
        worker = Worker(partition="davi-local", auto_register=False)

        @worker.workflow("pipeline")
        def pipeline(_ctx):
            return None

        @worker.step("extraction:page")
        def extract(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker,
                partition=worker.partition,
                connection="redis://localhost:6379",
            )

        # One queue per registered name, partition-suffixed, colon sanitized to a dash...
        self.assertIn("durable-tasks-pipeline@davi-local", _RecordingWorker.created_names)
        self.assertIn("durable-tasks-extraction-page@davi-local", _RecordingWorker.created_names)
        # ...NOT a single shared group queue.
        self.assertNotIn("durable-tasks-processing", _RecordingWorker.created_names)
        self.assertEqual(len(_RecordingWorker.created_names), 2)
        # The shared results queue stays single (prefix-driven, not per-name).
        self.assertIn("durable-results", _RecordingQueue.created_names)
        self.assertEqual(_RecordingQueue.created_names.count("durable-results"), 1)

    async def test_heartbeat_registers_per_name_partition_suffixed_group(self):
        worker = Worker(partition="davi-local", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, partition=worker.partition, connection="redis://localhost:6379"
            )

        self.assertEqual(
            _RecordingHeartbeat.calls,
            [{"prefix": "durable", "group": "crunch@davi-local"}],
        )

    async def test_no_partition_stays_bare_per_name(self):
        worker = Worker(auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, partition=worker.partition, connection="redis://localhost:6379"
            )

        self.assertIn("durable-tasks-crunch", _RecordingWorker.created_names)

    async def test_default_partition_string_stays_bare(self):
        worker = Worker(partition="default", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, partition=worker.partition, connection="redis://localhost:6379"
            )

        self.assertIn("durable-tasks-crunch", _RecordingWorker.created_names)

    async def test_tenant_alias_still_routes_to_partition_suffixed_queue(self):
        # REGRESSION GUARD: flip's Python worker runs `Worker(tenant=DURABLE_TENANT)` with NO explicit
        # partition and must keep subscribing to `<handler>@<tenant>` queues — else the operator
        # dispatching to e.g. `crunch@davi-local` never reaches it. `tenant=` maps to `partition`.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            worker = Worker(tenant="davi-local", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, partition=worker.partition, connection="redis://localhost:6379"
            )

        self.assertIn("durable-tasks-crunch@davi-local", _RecordingWorker.created_names)

    async def test_group_alias_does_not_suffix_the_queue(self):
        # `group=` is the ELIMINATED base axis: it must NOT contribute a suffix or a base. The queue
        # stays the bare handler-name queue.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            worker = Worker(group="processing", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, partition=worker.partition, connection="redis://localhost:6379"
            )

        self.assertIn("durable-tasks-crunch", _RecordingWorker.created_names)
        self.assertNotIn("durable-tasks-crunch@processing", _RecordingWorker.created_names)
        self.assertNotIn("durable-tasks-processing", _RecordingWorker.created_names)

    async def test_no_registered_names_raises(self):
        worker = Worker(auto_register=False)

        with _RunnerNamePatches():
            with self.assertRaises(ValueError):
                await run_redis_worker(worker, connection="redis://localhost:6379")


# ---------------------------------------------------------------------------
# Cross-SDK decision contract (Task 7): a `call` decision carries the PARTITION,
# never a derived base group or a dot-prefix of the step name.
# ---------------------------------------------------------------------------


class CallDecisionCarriesPartitionTest(unittest.TestCase):
    """The JS engine composes a remote step's dispatch queue as
    ``tenant_group(sanitize_queue_token(cmd.name), cmd.group)`` — it treats the decision's ``group``
    field as the isolation PARTITION on top of the step name. So a replaying Python worker must emit
    the step's partition there (the worker's own partition for a bare call, or an explicit one),
    NEVER a base group or a ``name.split('.')[0]`` dot-prefix — a base group leaked here would be
    read as a partition suffix and route the step to a queue no worker consumes (it never runs).

    Mirrors the JS ``WorkflowContext.resolveCallGroup`` (``step.partition ?? workflowPartition ?? ''``).
    """

    @staticmethod
    def _first_call_command(worker, workflow_name):
        task = {
            "taskId": "t0",
            "runId": "r1",
            "workflow": workflow_name,
            "input": None,
            "history": [],
            "pendingSignals": [],
        }
        decision = worker.process_workflow_task(task)
        return next(c for c in decision["commands"] if c["kind"] == "call")

    def test_bare_call_inherits_the_worker_partition(self):
        worker = Worker(partition="davi-local", auto_register=False)

        @worker.workflow("pipeline")
        def pipeline(ctx):
            return ctx.call("extraction:page", {"p": 1})

        cmd = self._first_call_command(worker, "pipeline")
        # The decision carries the PARTITION, not anything derived from the step name.
        self.assertEqual(cmd["group"], "davi-local")
        # Round-trip: the JS engine's composition lands on the exact queue the Task 8 worker subscribes
        # to (`durable-tasks-extraction-page@davi-local`).
        self.assertEqual(
            _tenant_group(sanitize_queue_token(cmd["name"]), cmd["group"]),
            "extraction-page@davi-local",
        )

    def test_unpartitioned_bare_call_is_bare_never_dot_prefix(self):
        worker = Worker(auto_register=False)

        @worker.workflow("pipeline")
        def pipeline(ctx):
            return ctx.call("payments.charge-card", {"p": 1})

        cmd = self._first_call_command(worker, "pipeline")
        # No partition → a bare-equivalent floor value. CRITICALLY not the old dot-prefix derivation
        # ("payments"), which would wrongly be read as a partition suffix by the engine.
        self.assertNotEqual(cmd["group"], "payments")
        self.assertEqual(
            _tenant_group(sanitize_queue_token(cmd["name"]), cmd["group"]),
            "payments.charge-card",
        )

    def test_explicit_call_partition_wins(self):
        worker = Worker(partition="davi-local", auto_register=False)

        @worker.workflow("pipeline")
        def pipeline(ctx):
            return ctx.call("x", {"p": 1}, group="other")

        cmd = self._first_call_command(worker, "pipeline")
        self.assertEqual(cmd["group"], "other")


# ---------------------------------------------------------------------------
# start_run — tenant decoupled from the wire prefix; run_id passes through verbatim
# ---------------------------------------------------------------------------


class _Capture:
    def __init__(self) -> None:
        self.added: List[Dict[str, Any]] = []


class _FakeQueue:
    _capture: Optional[_Capture] = None

    def __init__(self, name: str, _opts: Dict[str, Any]) -> None:
        self.name = name

    async def add(self, job_name: str, data: Any, _opts: Optional[Dict[str, Any]] = None) -> None:
        if _FakeQueue._capture is not None:
            _FakeQueue._capture.added.append({"queue": self.name, "job": job_name, "data": data})

    async def close(self) -> None:
        pass


def _patch_queue(capture: _Capture):
    _FakeQueue._capture = capture
    return patch("bullmq.Queue", _FakeQueue)


class StartRunTenantDecoupledFromWireTest(unittest.IsolatedAsyncioTestCase):
    async def test_tenant_field_is_the_declared_tenant_not_the_namespace(self):
        capture = _Capture()
        # namespace stays "default" (bare, shared wire); tenant is a distinct data label.
        worker = Worker(namespace="default", tenant="davi-local", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("checkout", {"qty": 1})
        data = capture.added[0]["data"]
        self.assertEqual(data["tenant"], "davi-local")
        # The queue itself stays on the SHARED (bare) wire — tenant never segments start_run's prefix.
        self.assertEqual(capture.added[0]["queue"], "durable-start-run")

    async def test_no_tenant_falls_back_to_namespace_back_compat(self):
        capture = _Capture()
        worker = Worker(namespace="acme", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", {})
        self.assertEqual(capture.added[0]["data"]["tenant"], "acme")

    async def test_run_id_passes_through_verbatim_no_fresh_uuid_minted(self):
        capture = _Capture()
        worker = Worker(tenant="davi-local", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", {}, run_id="caller-supplied-run-id")
        self.assertEqual(capture.added[0]["data"]["runId"], "caller-supplied-run-id")


if __name__ == "__main__":
    unittest.main()
