import asyncio
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
        # engine persists: the now() capture (epoch ms) + (later) the dispatched step's result.
        history += [
            {"seq": 0, "kind": "step", "name": "now#0", "output": 1735689600000},
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
        self.assertEqual(d3["output"], {"rows": 42, "startedAt": 1735689600000})
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

    def test_now_returns_epoch_milliseconds(self):
        """`ctx.now()` mirrors JS `Date.now()` — an epoch-**millisecond** integer, not an ISO string."""
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            ctx.now()
            ctx.step("x", group="g")  # block so we can inspect the recorded capture

        d1 = wf.process_task(task())
        recorded = d1["commands"][0]
        self.assertEqual(recorded["name"], "now#0")
        self.assertIsInstance(recorded["output"], int)
        # A sane epoch-ms magnitude (> year 2001 in ms), never seconds and never a string.
        self.assertGreater(recorded["output"], 1_000_000_000_000)

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

    def test_side_effect_records_once_then_replays_the_captured_value(self):
        """`ctx.side_effect(fn)` — the general capture primitive: run `fn` once, checkpoint under the
        constant `sideEffect` name, replay the same value without re-running `fn`."""
        wf = WorkflowWorker()
        runs = {"n": 0}

        @wf.workflow("wf")
        def flow(ctx, _input):
            def gen():
                runs["n"] += 1
                return f"id-{runs['n']}"

            first = ctx.side_effect(gen)
            ctx.step("x", group="g")  # block so we get two turns
            return {"first": first}

        d1 = wf.process_task(task())
        self.assertEqual(d1["status"], "continue")
        self.assertEqual([c["kind"] for c in d1["commands"]], ["recordStep", "call"])
        recorded_id = d1["commands"][0]["output"]
        self.assertEqual(d1["commands"][0]["name"], "sideEffect")
        self.assertEqual(recorded_id, "id-1")
        self.assertEqual(runs["n"], 1)  # fn ran exactly once

        history = [
            {"seq": 0, "kind": "step", "name": "sideEffect", "output": recorded_id},
            {"seq": 1, "kind": "call", "name": "x", "output": None},
        ]
        d2 = wf.process_task(task(history=history))
        self.assertEqual(d2["status"], "completed")
        self.assertEqual(d2["output"], {"first": recorded_id})
        self.assertEqual(runs["n"], 1)  # NOT re-run on replay

    def test_side_effect_supports_an_async_callable(self):
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            async def gen():
                return "async-value"

            captured = ctx.side_effect(gen)
            ctx.step("x", group="g")
            return {"captured": captured}

        d1 = wf.process_task(task())
        self.assertEqual(d1["commands"][0]["name"], "sideEffect")
        self.assertEqual(d1["commands"][0]["output"], "async-value")

    def test_side_effect_supports_an_async_callable_when_a_loop_is_already_running(self):
        """`process_task` normally runs off the event loop (a plain executor thread), so
        `side_effect`'s `asyncio.run` is safe there. Exercise the other case — called from a
        thread that already HAS a running loop — where a nested `asyncio.run` would raise
        `RuntimeError`; `side_effect` must still drive the coroutine and return its value."""
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            async def gen():
                return "async-value"

            captured = ctx.side_effect(gen)
            ctx.step("x", group="g")
            return {"captured": captured}

        async def run_under_a_loop():
            # `process_task` is synchronous, but calling it from inside a running coroutine puts
            # `side_effect`'s body on a thread that already has this loop running.
            return wf.process_task(task())

        d1 = asyncio.run(run_under_a_loop())
        self.assertEqual(d1["commands"][0]["name"], "sideEffect")
        self.assertEqual(d1["commands"][0]["output"], "async-value")

    def test_multiple_side_effects_are_distinct_history_entries(self):
        """Both records share the constant `sideEffect` name but sit at distinct seqs, so replay
        keys them by seq and never collides."""
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            a = ctx.side_effect(lambda: "a")
            b = ctx.side_effect(lambda: "b")
            ctx.step("x", group="g")
            return {"a": a, "b": b}

        d1 = wf.process_task(task())
        names = [(c["seq"], c["name"], c.get("output")) for c in d1["commands"] if c["kind"] == "recordStep"]
        self.assertEqual(names, [(0, "sideEffect", "a"), (1, "sideEffect", "b")])

    def test_now_and_side_effect_do_not_recompute_on_replay(self):
        """The captured value is whatever history says — even if it couldn't possibly have been
        produced by the real clock/generator — proving replay never re-invokes the body."""
        wf = WorkflowWorker()

        @wf.workflow("wf")
        def flow(ctx, _input):
            return {"now": ctx.now(), "id": ctx.side_effect(lambda: "recomputed")}

        history = [
            {"seq": 0, "kind": "step", "name": "now#0", "output": -1},
            {"seq": 1, "kind": "step", "name": "sideEffect", "output": "from-history"},
        ]
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "completed")
        self.assertEqual(d["output"], {"now": -1, "id": "from-history"})


if __name__ == "__main__":
    unittest.main()
