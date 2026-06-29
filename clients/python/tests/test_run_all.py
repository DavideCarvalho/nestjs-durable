"""Tests for run_all — the auto-discovery form on top of run_workers.

Every Worker/WorkflowWorker self-registers into a module-level registry on construction (unless
``auto_register=False``); run_all() runs every registered one via run_workers. We patch run_workers
where run_all looks it up (`durable_worker.worker.run_workers`) so we can inspect the workers arg
without a real Redis. The registry is global, so we clear it in setUp/tearDown for isolation.
"""

import unittest
from unittest.mock import patch

from durable_worker import (
    Worker,
    clear_registered_workers,
    register_worker,
    registered_workers,
    run_all,
)
from durable_worker.workflow import WorkflowWorker


class RunAllTest(unittest.TestCase):
    def setUp(self):
        clear_registered_workers()

    def tearDown(self):
        clear_registered_workers()

    def test_constructing_workers_auto_registers_them(self):
        step_worker = Worker(group="a")
        wf_worker = WorkflowWorker(group="b")

        workers = registered_workers()

        self.assertIn(step_worker, workers)
        self.assertIn(wf_worker, workers)
        self.assertEqual(len(workers), 2)

    def test_auto_register_false_skips_the_registry(self):
        opted_out_step = Worker(group="a", auto_register=False)
        opted_out_wf = WorkflowWorker(group="b", auto_register=False)

        workers = registered_workers()

        self.assertNotIn(opted_out_step, workers)
        self.assertNotIn(opted_out_wf, workers)
        self.assertEqual(workers, [])

    def test_register_worker_is_idempotent_on_identity(self):
        step_worker = Worker(group="a")  # already registered once on construction

        register_worker(step_worker)
        register_worker(step_worker)

        self.assertEqual(registered_workers().count(step_worker), 1)

    def test_registered_workers_returns_a_copy(self):
        Worker(group="a")
        snapshot = registered_workers()
        snapshot.clear()  # mutating the copy must not touch the registry

        self.assertEqual(len(registered_workers()), 1)

    def test_run_all_runs_exactly_the_registered_workers(self):
        step_worker = Worker(group="a")
        wf_worker = WorkflowWorker(group="b")

        seen = {}

        def fake_run_workers(workers, *, redis, prefix, namespace="default"):
            seen["workers"] = list(workers)
            seen["redis"] = redis
            seen["prefix"] = prefix
            seen["namespace"] = namespace

        with patch("durable_worker.worker.run_workers", side_effect=fake_run_workers):
            run_all(redis="redis://example:6379", prefix="myprefix", namespace="dev-alice")

        self.assertEqual(seen["workers"], [step_worker, wf_worker])
        self.assertEqual(seen["redis"], "redis://example:6379")
        self.assertEqual(seen["prefix"], "myprefix")
        self.assertEqual(seen["namespace"], "dev-alice")

    def test_run_all_passes_default_redis_and_prefix(self):
        Worker(group="a")
        seen = {}

        def fake_run_workers(workers, *, redis, prefix, namespace="default"):
            seen["redis"] = redis
            seen["prefix"] = prefix
            seen["namespace"] = namespace

        with patch("durable_worker.worker.run_workers", side_effect=fake_run_workers):
            run_all()

        self.assertEqual(seen["redis"], "redis://localhost:6379")
        self.assertEqual(seen["prefix"], "durable")
        self.assertEqual(seen["namespace"], "default")

    def test_run_all_with_empty_registry_does_not_call_run_workers(self):
        """No registered workers → run_all early-returns; run_workers is never called (no hang)."""
        called = {"n": 0}

        def fake_run_workers(workers, *, redis, prefix, namespace="default"):
            called["n"] += 1

        with patch("durable_worker.worker.run_workers", side_effect=fake_run_workers):
            run_all()

        self.assertEqual(called["n"], 0)


if __name__ == "__main__":
    unittest.main()
