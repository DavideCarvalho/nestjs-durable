"""P4.3 — Worker.start_run publishes a StartRunMessage onto <effectivePrefix>-start-run.

All tests are offline: bullmq.Queue is monkey-patched so no live Redis is needed.  The cross-SDK
wire contract under test:

    queue name  : <effectivePrefix>-start-run
    job name    : "startRun"
    payload     : { tenant, workflow, input, runId?, tags? }

where effectivePrefix follows the cross-SDK rule (_effective_prefix):
    "default" (or unset) namespace → bare prefix (e.g. "durable-start-run")
    other namespace → "<prefix>-<namespace>-start-run"
"""

import asyncio
import unittest
from typing import Any, Dict, List, Optional
from unittest.mock import patch

from durable_worker import Worker


# ---------------------------------------------------------------------------
# Minimal fake BullMQ Queue that records what was enqueued
# ---------------------------------------------------------------------------

class _Capture:
    """Shared mutable state across all FakeQueue instances for a test."""
    def __init__(self) -> None:
        self.added: List[Dict[str, Any]] = []
        self.closed_names: List[str] = []


class _FakeQueue:
    _capture: Optional[_Capture] = None

    def __init__(self, name: str, _opts: Dict[str, Any]) -> None:
        self.name = name

    async def add(self, job_name: str, data: Any, _opts: Optional[Dict[str, Any]] = None) -> None:
        if _FakeQueue._capture is not None:
            _FakeQueue._capture.added.append({"queue": self.name, "job": job_name, "data": data})

    async def close(self) -> None:
        if _FakeQueue._capture is not None:
            _FakeQueue._capture.closed_names.append(self.name)


def _patch_queue(capture: _Capture):
    """Context manager that patches bullmq.Queue with _FakeQueue and binds the capture."""
    _FakeQueue._capture = capture
    return patch("bullmq.Queue", _FakeQueue)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class StartRunQueueNameTest(unittest.IsolatedAsyncioTestCase):
    """Queue name must follow the cross-SDK effectivePrefix rule."""

    async def test_default_namespace_uses_bare_prefix(self) -> None:
        capture = _Capture()
        worker = Worker("processing", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("checkout", {"qty": 1})
        self.assertEqual(capture.added[0]["queue"], "durable-start-run")

    async def test_non_default_namespace_is_segmented(self) -> None:
        capture = _Capture()
        worker = Worker("processing", namespace="dev-alice", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("checkout", {"qty": 1})
        self.assertEqual(capture.added[0]["queue"], "durable-dev-alice-start-run")

    async def test_custom_prefix_is_respected(self) -> None:
        capture = _Capture()
        worker = Worker("processing", prefix="flip", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("checkout", {"qty": 1})
        self.assertEqual(capture.added[0]["queue"], "flip-start-run")

    async def test_custom_prefix_and_namespace_combined(self) -> None:
        capture = _Capture()
        worker = Worker("processing", prefix="flip", namespace="dev-bob", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("checkout", {})
        self.assertEqual(capture.added[0]["queue"], "flip-dev-bob-start-run")

    async def test_default_namespace_string_stays_bare(self) -> None:
        capture = _Capture()
        worker = Worker("processing", namespace="default", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", None)
        queue_name = capture.added[0]["queue"]
        self.assertEqual(queue_name, "durable-start-run")
        self.assertNotIn("default", queue_name)


class StartRunPayloadTest(unittest.IsolatedAsyncioTestCase):
    """The published StartRunMessage must carry the correct fields."""

    async def test_required_fields_are_present(self) -> None:
        capture = _Capture()
        worker = Worker("processing", namespace="acme", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("invoice", {"orderId": "o-1"})
        data = capture.added[0]["data"]
        self.assertEqual(data["tenant"], "acme")
        self.assertEqual(data["workflow"], "invoice")
        self.assertEqual(data["input"], {"orderId": "o-1"})

    async def test_run_id_is_included_when_provided(self) -> None:
        capture = _Capture()
        worker = Worker("processing", namespace="acme", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", None, run_id="run-99")
        self.assertEqual(capture.added[0]["data"].get("runId"), "run-99")

    async def test_tags_are_included_when_provided(self) -> None:
        capture = _Capture()
        worker = Worker("processing", namespace="acme", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", None, tags=["batch", "urgent"])
        self.assertEqual(capture.added[0]["data"].get("tags"), ["batch", "urgent"])

    async def test_run_id_absent_when_not_provided(self) -> None:
        capture = _Capture()
        worker = Worker("processing", namespace="acme", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", None)
        self.assertNotIn("runId", capture.added[0]["data"])

    async def test_tags_absent_when_not_provided(self) -> None:
        capture = _Capture()
        worker = Worker("processing", namespace="acme", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", None)
        self.assertNotIn("tags", capture.added[0]["data"])

    async def test_job_name_is_startrun(self) -> None:
        capture = _Capture()
        worker = Worker("processing", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", {})
        self.assertEqual(capture.added[0]["job"], "startRun")

    async def test_tenant_is_worker_namespace(self) -> None:
        """The tenant field mirrors self.namespace so the control plane routes it correctly."""
        capture = _Capture()
        worker = Worker("processing", namespace="tenant-xyz", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", {})
        self.assertEqual(capture.added[0]["data"]["tenant"], "tenant-xyz")


class StartRunCleanupTest(unittest.IsolatedAsyncioTestCase):
    """Queue.close() must be called after the job is added (one-shot lifecycle)."""

    async def test_queue_is_closed_after_publish(self) -> None:
        capture = _Capture()
        worker = Worker("processing", auto_register=False)
        with _patch_queue(capture):
            await worker.start_run("wf", {})
        self.assertIn("durable-start-run", capture.closed_names)


if __name__ == "__main__":
    unittest.main()
