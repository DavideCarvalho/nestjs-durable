"""P4C.3 — tenant != namespace (Python worker side).

Review finding IMPORTANT #2: today ``Worker.namespace`` conflates two unrelated concerns — the
effective queue PREFIX (the shared transport a worker connects to) and the ``tenant`` field stamped
on a ``start_run`` request. A pure Python tenant worker connecting to a shared control-plane
transport needs to declare its tenant identity WITHOUT segmenting its wire (the prefix it shares
with every other tenant on that control plane).

This fixes it: ``Worker`` gains a ``tenant`` attribute, distinct from ``namespace``.

    - ``_tenant_group(base_group, tenant)`` is the byte-identical Python mirror of the TypeScript
      ``tenantGroup`` (``packages/core/src/tenant-group.ts``): ``undefined``/``''``/``'default'`` ->
      the bare ``base_group``; any other tenant -> ``"<base_group>@<tenant>"``.
    - The worker GROUP it registers/heartbeats under (and therefore the ``<prefix>-tasks-<group>``
      queue it consumes) is derived via ``_tenant_group(group, tenant)`` — so tenant selects which
      group's queue this instance serves.
    - The transport PREFIX (``_effective_prefix``, driven by ``namespace``) is UNTOUCHED by
      ``tenant`` — a namespace-scoped engine keeps behaving exactly as today.
    - ``start_run`` stamps ``tenant = self.tenant or self.namespace`` (back-compat: with no
      ``tenant`` given, behaves byte-identically to before — tenant defaults to namespace).
    - ``run_id`` passes through to the StartRunMessage verbatim (the idempotency key) — no fresh
      uuid minted inside this retryable BullMQ dispatch path.
"""

import unittest
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from durable_worker import Worker
from durable_worker.redis_runner import _tenant_group, run_redis_worker


# ---------------------------------------------------------------------------
# _tenant_group — cross-SDK conformance (byte-identical to TS tenantGroup)
# ---------------------------------------------------------------------------


class TenantGroupTest(unittest.TestCase):
    def test_real_tenant_suffixes_the_group(self):
        self.assertEqual(_tenant_group("processing", "davi-local"), "processing@davi-local")

    def test_none_tenant_is_bare_group(self):
        self.assertEqual(_tenant_group("processing", None), "processing")

    def test_empty_string_tenant_is_bare_group(self):
        self.assertEqual(_tenant_group("processing", ""), "processing")

    def test_default_tenant_is_bare_group(self):
        self.assertEqual(_tenant_group("processing", "default"), "processing")


# ---------------------------------------------------------------------------
# run_redis_worker — tenant selects the GROUP (task queue + heartbeat), NOT the prefix
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
    """Captures the (prefix, group) pair _start_heartbeat was called with."""

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


class RunRedisWorkerTenantGroupTest(unittest.IsolatedAsyncioTestCase):
    async def test_tenant_suffixes_the_task_queue_group_not_the_prefix(self):
        worker = Worker("processing", namespace="default", tenant="davi-local", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker,
                group=worker.group,
                connection="redis://localhost:6379",
                namespace=worker.namespace,
                tenant=worker.tenant,
            )

        # Task queue is tenant-suffixed (a real tenant selects its own group's queue)...
        self.assertIn("durable-tasks-processing@davi-local", _RecordingWorker.created_names)
        self.assertNotIn("durable-tasks-processing", _RecordingWorker.created_names)
        # ...but the shared results queue (prefix-driven, not group-driven) is untouched — the
        # transport PREFIX stays shared across tenants.
        self.assertIn("durable-results", _RecordingQueue.created_names)

    async def test_heartbeat_registers_under_the_tenant_suffixed_group(self):
        worker = Worker("processing", tenant="davi-local", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker,
                group=worker.group,
                connection="redis://localhost:6379",
                tenant=worker.tenant,
            )

        self.assertEqual(
            _RecordingHeartbeat.calls[0],
            {"prefix": "durable", "group": "processing@davi-local"},
        )

    async def test_no_tenant_stays_byte_identical_to_today(self):
        worker = Worker("processing", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, group=worker.group, connection="redis://localhost:6379"
            )

        self.assertIn("durable-tasks-processing", _RecordingWorker.created_names)
        self.assertEqual(
            _RecordingHeartbeat.calls[0], {"prefix": "durable", "group": "processing"}
        )

    async def test_default_tenant_string_stays_bare(self):
        worker = Worker("processing", tenant="default", auto_register=False)

        @worker.step("crunch")
        def crunch(_data):
            return None

        with _RunnerNamePatches():
            await run_redis_worker(
                worker, group=worker.group, connection="redis://localhost:6379", tenant=worker.tenant
            )

        self.assertIn("durable-tasks-processing", _RecordingWorker.created_names)


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
        worker = Worker("processing", namespace="default", tenant="davi-local", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("checkout", {"qty": 1})
        data = capture.added[0]["data"]
        self.assertEqual(data["tenant"], "davi-local")
        # The queue itself stays on the SHARED (bare) wire — tenant never segments start_run's prefix.
        self.assertEqual(capture.added[0]["queue"], "durable-start-run")

    async def test_no_tenant_falls_back_to_namespace_back_compat(self):
        capture = _Capture()
        worker = Worker("processing", namespace="acme", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", {})
        self.assertEqual(capture.added[0]["data"]["tenant"], "acme")

    async def test_run_id_passes_through_verbatim_no_fresh_uuid_minted(self):
        capture = _Capture()
        worker = Worker("processing", tenant="davi-local", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", {}, run_id="caller-supplied-run-id")
        self.assertEqual(capture.added[0]["data"]["runId"], "caller-supplied-run-id")


if __name__ == "__main__":
    unittest.main()
