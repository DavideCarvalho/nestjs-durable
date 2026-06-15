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
    def test_local_step_then_remote_call_then_sleep_completes_across_turns(self):
        wf = WorkflowWorker(group="wf")

        @wf.workflow("wf")
        def pipeline(ctx, base_id):
            key = ctx.step("setup", lambda: f"/{base_id}/data.csv")
            rows = ctx.call("ingestion", {"key": key}, group="pipeline")
            ctx.sleep(60_000)
            return {"rows": rows, "key": key}

        t = task(input="b1")
        history = []

        # Turn 1: runs the local step (recorded) and blocks on the remote call.
        d1 = drive(wf, t, history)
        self.assertEqual(d1["status"], "continue")
        self.assertEqual([c["kind"] for c in d1["commands"]], ["recordStep", "call"])
        self.assertEqual(d1["commands"][0]["output"], "/b1/data.csv")
        self.assertEqual(d1["commands"][1]["name"], "ingestion")
        # engine persists: the local step result + (later) the call result.
        history += [
            {"seq": 0, "kind": "step", "name": "setup", "output": "/b1/data.csv"},
            {"seq": 1, "kind": "call", "name": "ingestion", "output": 42},
        ]

        # Turn 2: replays setup + call from history, blocks on the timer.
        d2 = drive(wf, t, history)
        self.assertEqual(d2["status"], "continue")
        self.assertEqual([c["kind"] for c in d2["commands"]], ["sleep"])
        self.assertEqual(d2["commands"][0]["ms"], 60_000)
        history.append({"seq": 2, "kind": "timer"})

        # Turn 3: everything resolved → the workflow completes.
        d3 = drive(wf, t, history)
        self.assertEqual(d3["status"], "completed")
        self.assertEqual(d3["output"], {"rows": 42, "key": "/b1/data.csv"})
        self.assertEqual(d3["commands"], [])

    def test_a_failed_remote_call_is_catchable_in_workflow_code(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            try:
                ctx.call("risky", group="g")
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
            ctx.call("risky", group="g")

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
            ctx.call("a", group="g")

        # history says seq 0 was a timer, but the code calls a step — the run must fail loudly.
        history = [{"seq": 0, "kind": "timer"}]
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "failed")
        self.assertIn("history at seq 0", d["error"]["message"])

    def test_unknown_workflow_fails_cleanly(self):
        d = WorkflowWorker().process_task(task(workflow="nope"))
        self.assertEqual(d["status"], "failed")
        self.assertEqual(d["error"]["code"], "no_workflow")

    def test_local_step_runs_once_then_replays_without_rerunning(self):
        wf = WorkflowWorker()
        runs = {"n": 0}

        @wf.workflow("wf")
        def flow(ctx, _input):
            def body():
                runs["n"] += 1
                return runs["n"]

            first = ctx.step("count", body)
            ctx.call("x", group="g")  # block so we get two turns
            return {"first": first}

        wf.process_task(task())  # turn 1: runs body once
        self.assertEqual(runs["n"], 1)
        # turn 2: history has the recorded step → body must NOT run again
        history = [
            {"seq": 0, "kind": "step", "name": "count", "output": 1},
            {"seq": 1, "kind": "call", "name": "x", "output": None},
        ]
        d = wf.process_task(task(history=history))
        self.assertEqual(runs["n"], 1)  # unchanged — replayed, not re-run
        self.assertEqual(d["status"], "completed")
        self.assertEqual(d["output"], {"first": 1})


if __name__ == "__main__":
    unittest.main()
