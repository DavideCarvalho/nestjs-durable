import unittest

from durable_worker import GatherFailed
from durable_worker.workflow import StepFailed


class GatherFailedTest(unittest.TestCase):
    def test_is_a_stepfailed_with_aggregate_error(self):
        errs = [
            {"name": "handle_MEL", "error": {"message": "boom"}},
            {"name": "handle_MVR", "error": {"message": "nope"}},
        ]
        gf = GatherFailed(errs)
        self.assertIsInstance(gf, StepFailed)
        self.assertEqual(gf.errors, errs)
        self.assertEqual(gf.error["errors"], errs)
        self.assertIn("handle_MEL", gf.error["message"])
        self.assertIn("handle_MVR", gf.error["message"])


from durable_worker.workflow import WorkflowContext, GatherFailed as _GF  # noqa: E402


class GatherStepsTest(unittest.TestCase):
    def _ctx(self, history=None, is_cancelled=None):
        return WorkflowContext("run1", history or [], is_cancelled=is_cancelled)

    def test_runs_all_and_returns_results_in_input_order(self):
        ctx = self._ctx()
        out = ctx.gather([
            ("a", lambda: 1),
            ("b", lambda: 2),
            ("c", lambda: 3),
        ])
        self.assertEqual(out, [1, 2, 3])
        # Reserves seqs 0,1,2 in list order and records one step command each.
        steps = [c for c in ctx.commands if c["kind"] == "recordStep"]
        self.assertEqual([c["seq"] for c in steps], [0, 1, 2])
        self.assertEqual([c["name"] for c in steps], ["a", "b", "c"])
        # All share one parallelGroup marker.
        groups = {c["parallelGroup"] for c in steps}
        self.assertEqual(len(groups), 1)

    def test_replay_does_not_rerun_bodies(self):
        history = [
            {"seq": 0, "kind": "step", "name": "a", "output": 1},
            {"seq": 1, "kind": "step", "name": "b", "output": 2},
        ]
        ctx = self._ctx(history)

        def boom():
            raise AssertionError("body must not run on replay")

        out = ctx.gather([("a", boom), ("b", boom)])
        self.assertEqual(out, [1, 2])
        self.assertEqual(ctx.commands, [])  # nothing re-recorded

    def test_wait_all_aggregates_failures_and_records_every_outcome(self):
        ctx = self._ctx()

        def fail():
            raise ValueError("boom")

        with self.assertRaises(_GF) as cm:
            ctx.gather([("ok", lambda: 1), ("bad", fail), ("ok2", lambda: 2)])
        names = [e["name"] for e in cm.exception.errors]
        self.assertEqual(names, ["bad"])
        # wait_all still records all three step commands (ok, bad, ok2).
        recorded = [c["name"] for c in ctx.commands if c["kind"] == "recordStep"]
        self.assertEqual(recorded, ["ok", "bad", "ok2"])
        bad = next(c for c in ctx.commands if c["name"] == "bad")
        self.assertIn("error", bad)

    def test_empty_items_returns_empty(self):
        ctx = self._ctx()
        self.assertEqual(ctx.gather([]), [])
        self.assertEqual(ctx.commands, [])

    def test_single_item_behaves_like_one_step(self):
        ctx = self._ctx()
        out = ctx.gather([("only", lambda: 42)])
        self.assertEqual(out, [42])
        steps = [c for c in ctx.commands if c["kind"] == "recordStep"]
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["output"], 42)

    def test_fail_fast_signals_cooperative_cancel_to_siblings(self):
        from durable_worker.worker import current_step
        import threading

        ctx = self._ctx()
        sibling_saw_cancel = threading.Event()
        first_failed = threading.Event()

        def fail():
            first_failed.set()
            raise ValueError("boom")

        def sibling():
            # Wait until the failing item has failed, then observe cooperative cancel.
            first_failed.wait(timeout=2)
            step = current_step()
            for _ in range(200):
                if step is not None and step.cancelled:
                    sibling_saw_cancel.set()
                    return "cancelled"
                threading.Event().wait(0.005)
            return "ran-to-completion"

        with self.assertRaises(_GF):
            ctx.gather([("bad", fail), ("sib", sibling)], mode="fail_fast")
        self.assertTrue(sibling_saw_cancel.is_set())


from durable_worker.workflow import _Suspend  # noqa: E402


class GatherChildrenTest(unittest.TestCase):
    def _ctx(self, history=None):
        return WorkflowContext("run1", history or [])

    def test_first_turn_dispatches_all_children_then_suspends(self):
        ctx = self._ctx()
        with self.assertRaises(_Suspend):
            ctx.gather_children("handle", [{"p": "MEL"}, {"p": "MVR"}, {"p": "UTIL"}])
        spawns = [c for c in ctx.commands if c["kind"] == "startChild"]
        self.assertEqual([c["seq"] for c in spawns], [0, 1, 2])
        self.assertEqual([c["workflow"] for c in spawns], ["handle", "handle", "handle"])
        self.assertEqual([c["input"]["p"] for c in spawns], ["MEL", "MVR", "UTIL"])
        self.assertEqual(len({c["parallelGroup"] for c in spawns}), 1)

    def test_suspends_while_any_child_outstanding(self):
        # seq 0 done, seq 1 still running (absent from history) → re-dispatch missing + suspend.
        history = [{"seq": 0, "kind": "child", "name": "handle", "output": {"r": 1}}]
        ctx = self._ctx(history)
        with self.assertRaises(_Suspend):
            ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}])
        spawns = [c for c in ctx.commands if c["kind"] == "startChild"]
        self.assertEqual([c["seq"] for c in spawns], [1])  # only the outstanding one re-emitted

    def test_returns_all_outputs_in_order_when_all_resolved(self):
        history = [
            {"seq": 0, "kind": "child", "name": "handle", "output": {"r": 1}},
            {"seq": 1, "kind": "child", "name": "handle", "output": {"r": 2}},
        ]
        ctx = self._ctx(history)
        out = ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}])
        self.assertEqual(out, [{"r": 1}, {"r": 2}])
        self.assertEqual(ctx.commands, [])

    def test_wait_all_aggregates_child_failures(self):
        history = [
            {"seq": 0, "kind": "child", "name": "handle", "output": {"r": 1}},
            {"seq": 1, "kind": "child", "name": "handle", "error": {"message": "child boom"}},
        ]
        ctx = self._ctx(history)
        with self.assertRaises(_GF) as cm:
            ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}])
        self.assertEqual(len(cm.exception.errors), 1)
        self.assertEqual(cm.exception.errors[0]["error"]["message"], "child boom")

    def test_fail_fast_raises_on_first_failed_child_seen(self):
        history = [
            {"seq": 0, "kind": "child", "name": "handle", "error": {"message": "boom"}},
        ]
        ctx = self._ctx(history)
        # seq 1 still outstanding, but fail_fast raises immediately on the failed seq 0.
        with self.assertRaises(_GF):
            ctx.gather_children("handle", [{"p": "A"}, {"p": "B"}], mode="fail_fast")

    def test_empty_inputs_returns_empty(self):
        ctx = self._ctx()
        self.assertEqual(ctx.gather_children("handle", []), [])
        self.assertEqual(ctx.commands, [])


from durable_worker.workflow import WorkflowWorker  # noqa: E402


class GatherProcessTaskTest(unittest.TestCase):
    def test_wait_all_failure_becomes_a_failed_decision_with_aggregate(self):
        ww = WorkflowWorker(group="t", auto_register=False)

        @ww.workflow("wf")
        def wf(ctx, _input):
            return ctx.gather([("ok", lambda: 1), ("bad", lambda: (_ for _ in ()).throw(ValueError("x")))])

        decision = ww.process_task({"taskId": "t1", "runId": "r1", "workflow": "wf",
                                    "history": [], "input": None})
        self.assertEqual(decision["status"], "failed")
        self.assertEqual(decision["error"]["errors"][0]["name"], "bad")
        # The two step commands were still recorded on the failed decision.
        recorded = [c["name"] for c in decision["commands"] if c["kind"] == "recordStep"]
        self.assertEqual(recorded, ["ok", "bad"])

    def test_success_replays_deterministically(self):
        ww = WorkflowWorker(group="t", auto_register=False)
        calls = {"n": 0}

        @ww.workflow("wf")
        def wf(ctx, _input):
            def body_a():
                calls["n"] += 1
                return "a"
            return ctx.gather([("a", body_a), ("b", lambda: "b")])

        first = ww.process_task({"taskId": "t1", "runId": "r1", "workflow": "wf",
                                 "history": [], "input": None})
        self.assertEqual(first["status"], "completed")
        self.assertEqual(first["output"], ["a", "b"])
        # Replay from the recorded history must NOT re-run body_a.
        history = [
            {"seq": c["seq"], "kind": "step", "name": c["name"], "output": c.get("output")}
            for c in first["commands"] if c["kind"] == "recordStep"
        ]
        before = calls["n"]
        second = ww.process_task({"taskId": "t1", "runId": "r1", "workflow": "wf",
                                  "history": history, "input": None})
        self.assertEqual(second["status"], "completed")
        self.assertEqual(second["output"], ["a", "b"])
        self.assertEqual(calls["n"], before)  # no re-run on replay


if __name__ == "__main__":
    unittest.main()
