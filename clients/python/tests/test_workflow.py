import unittest

from durable_worker import WorkflowWorker
from durable_worker.workflow import NondeterminismError, StepFailed, WorkflowContext


def task(workflow="wf", input=None, history=None, pending=None, **over):
    base = {
        "taskId": "t0",
        "runId": "r1",
        "workflow": workflow,
        "workflowVersion": "1",
        "input": input,
        "history": history or [],
        "pendingSignals": pending or [],
    }
    base.update(over)
    return base


def drive(worker, t, history):
    """One engine turn: send the task with the accumulated history, return the decision."""
    return worker.process_task({**t, "history": history})


class WorkflowReplayTest(unittest.TestCase):
    def test_now_then_dispatched_step_then_sleep_completes_across_turns(self):
        wf = WorkflowWorker(group="wf")

        @wf.workflow("wf")
        def pipeline(ctx, base_id):
            started_at = ctx.now()
            rows = ctx.step("ingestion", {"key": f"/{base_id}/data.csv"}, group="pipeline")
            ctx.sleep(60_000)
            return {"rows": rows, "startedAt": started_at}

        t = task(input="b1")
        history = []

        # Turn 1: runs the ctx.now() capture (recorded) and blocks on the dispatched step.
        d1 = drive(wf, t, history)
        self.assertEqual(d1["status"], "continue")
        self.assertEqual([c["kind"] for c in d1["commands"]], ["recordStep", "call"])
        self.assertEqual(d1["commands"][0]["name"], "now#0")
        self.assertEqual(d1["commands"][1]["name"], "ingestion")
        self.assertEqual(d1["commands"][1]["input"], {"key": "/b1/data.csv"})
        # engine persists: the now() capture + (later) the dispatched step's result.
        history += [
            {"seq": 0, "kind": "step", "name": "now#0", "output": "2026-01-01T00:00:00+00:00"},
            {"seq": 1, "kind": "call", "name": "ingestion", "output": 42},
        ]

        # Turn 2: replays now()/ingestion from history, blocks on the timer.
        d2 = drive(wf, t, history)
        self.assertEqual(d2["status"], "continue")
        self.assertEqual([c["kind"] for c in d2["commands"]], ["sleep"])
        self.assertEqual(d2["commands"][0]["ms"], 60_000)
        history.append({"seq": 2, "kind": "timer"})

        # Turn 3: everything resolved → the workflow completes.
        d3 = drive(wf, t, history)
        self.assertEqual(d3["status"], "completed")
        self.assertEqual(d3["output"], {"rows": 42, "startedAt": "2026-01-01T00:00:00+00:00"})
        self.assertEqual(d3["commands"], [])

    def test_a_failed_dispatched_step_is_catchable_in_workflow_code(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            try:
                ctx.step("risky", group="g")
                return {"ok": True}
            except StepFailed:
                return {"ok": False, "compensated": True}

        history = [{"seq": 0, "kind": "call", "name": "risky", "error": {"message": "boom"}}]
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "completed")
        self.assertEqual(d["output"], {"ok": False, "compensated": True})

    def test_uncaught_failure_fails_the_run(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            ctx.step("risky", group="g")

        history = [{"seq": 0, "kind": "call", "name": "risky", "error": {"message": "boom"}}]
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "failed")
        self.assertEqual(d["error"]["message"], "boom")

    def test_wait_signal_resolves_from_pending_then_blocks(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            approved = ctx.wait_signal("approve")
            return {"approved": approved}

        # not delivered yet → blocks
        blocked = wf.process_task(task())
        self.assertEqual(blocked["status"], "continue")
        self.assertEqual(blocked["commands"][0], {"kind": "waitSignal", "seq": 0, "signal": "approve"})
        # delivered → resolves
        done = wf.process_task(
            task(pending=[{"seq": 0, "signal": "approve", "payload": {"by": "davi"}}])
        )
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["output"], {"approved": {"by": "davi"}})

    def test_nondeterminism_is_detected(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            ctx.step("a", group="g")

        # history says seq 0 was a timer, but the code dispatches a step — the run must fail loudly.
        history = [{"seq": 0, "kind": "timer"}]
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "failed")
        self.assertIn("history at seq 0", d["error"]["message"])

    def test_unknown_workflow_fails_cleanly(self):
        d = WorkflowWorker().process_task(task(workflow="nope"))
        self.assertEqual(d["status"], "failed")
        self.assertEqual(d["error"]["code"], "no_workflow")

    def test_step_dispatches_the_same_call_decision_the_old_call_method_used_to_emit(self):
        """`.step(name, input)` is a RENAME of `.call(name, input, group=...)` — the wire it emits
        must be byte-identical to what `.call` emitted (this task's core parity requirement)."""
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            return ctx.step("ingestion", {"key": "/b1/data.csv"}, group="pipeline")

        d = wf.process_task(task())
        self.assertEqual(d["status"], "continue")
        self.assertEqual(
            d["commands"],
            [
                {
                    "kind": "call",
                    "seq": 0,
                    "name": "ingestion",
                    "group": "pipeline",
                    "input": {"key": "/b1/data.csv"},
                }
            ],
        )

    def test_call_is_removed_no_alias(self):
        ctx = WorkflowContext("r1", [], group="g")
        self.assertFalse(hasattr(ctx, "call"))

    def test_now_records_once_then_replays_the_captured_value(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            first = ctx.now()
            ctx.step("x", group="g")  # block so we get two turns
            return {"first": first}

        d1 = wf.process_task(task())
        self.assertEqual(d1["status"], "continue")
        self.assertEqual([c["kind"] for c in d1["commands"]], ["recordStep", "call"])
        recorded_ts = d1["commands"][0]["output"]
        self.assertEqual(d1["commands"][0]["name"], "now#0")

        history = [
            {"seq": 0, "kind": "step", "name": "now#0", "output": recorded_ts},
            {"seq": 1, "kind": "call", "name": "x", "output": None},
        ]
        d2 = wf.process_task(task(history=history))
        self.assertEqual(d2["status"], "completed")
        self.assertEqual(d2["output"], {"first": recorded_ts})

    def test_uuid_records_once_then_replays_the_captured_value(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            first = ctx.uuid()
            ctx.step("x", group="g")  # block so we get two turns
            return {"first": first}

        d1 = wf.process_task(task())
        self.assertEqual(d1["status"], "continue")
        self.assertEqual([c["kind"] for c in d1["commands"]], ["recordStep", "call"])
        recorded_uuid = d1["commands"][0]["output"]
        self.assertEqual(d1["commands"][0]["name"], "uuid#0")
        self.assertTrue(recorded_uuid)  # non-empty

        history = [
            {"seq": 0, "kind": "step", "name": "uuid#0", "output": recorded_uuid},
            {"seq": 1, "kind": "call", "name": "x", "output": None},
        ]
        d2 = wf.process_task(task(history=history))
        self.assertEqual(d2["status"], "completed")
        self.assertEqual(d2["output"], {"first": recorded_uuid})

    def test_now_and_uuid_do_not_recompute_on_replay(self):
        """The captured value is whatever history says — even if it couldn't possibly have been
        produced by the real clock/uuid generator — proving replay never re-invokes the body."""
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            return {"now": ctx.now(), "uuid": ctx.uuid()}

        history = [
            {"seq": 0, "kind": "step", "name": "now#0", "output": "not-a-real-timestamp"},
            {"seq": 1, "kind": "step", "name": "uuid#1", "output": "not-a-real-uuid"},
        ]
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "completed")
        self.assertEqual(d["output"], {"now": "not-a-real-timestamp", "uuid": "not-a-real-uuid"})


if __name__ == "__main__":
    unittest.main()
