import unittest

from durable_worker import WorkflowWorker
from durable_worker.workflow import NondeterminismError, StepFailed, WorkflowContext


def task(history=None, **over):
    base = {
        "taskId": "t0",
        "runId": "r1",
        "workflow": "wf",
        "workflowVersion": "1",
        "input": None,
        "history": history or [],
        "pendingSignals": [],
    }
    base.update(over)
    return base


class WaitForAnyTest(unittest.TestCase):
    def test_emits_one_wait_any_command_with_every_condition(self):
        wf = WorkflowWorker(group="wf")

        @wf.workflow("wf")
        def race(ctx, _input):
            return ctx.wait_for_any(
                "race",
                {
                    "go": ctx.signal_wait("go"),
                    "late": ctx.timer(7_200_000),
                    "at": ctx.timer(until=5000),
                    "kid": ctx.child_wait("child-1"),
                },
            )

        d = wf.process_task(task())
        self.assertEqual(d["status"], "continue")
        self.assertEqual(
            d["commands"],
            [
                {
                    "kind": "waitAny",
                    "seq": 0,
                    "name": "race",
                    "conditions": [
                        {"key": "go", "kind": "signal", "signal": "go"},
                        {"key": "late", "kind": "timer", "ms": 7_200_000},
                        {"key": "at", "kind": "timer", "until": 5000},
                        {"key": "kid", "kind": "child", "childId": "child-1"},
                    ],
                }
            ],
        )

    def test_replays_the_journaled_winner_and_continues(self):
        wf = WorkflowWorker(group="wf")

        @wf.workflow("wf")
        def race(ctx, _input):
            outcome = ctx.wait_for_any("race", {"go": ctx.signal_wait("go"), "t": ctx.timer(1000)})
            after = ctx.wait_signal("next")
            return {"outcome": outcome, "after": after}

        history = [{"seq": 0, "kind": "any", "name": "race", "output": {"key": "go", "value": 7}}]
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "continue")
        self.assertEqual(d["commands"], [{"kind": "waitSignal", "seq": 1, "signal": "next"}])
        history.append({"seq": 1, "kind": "signal", "output": "n"})
        d = wf.process_task(task(history=history))
        self.assertEqual(d["status"], "completed")
        self.assertEqual(d["output"], {"outcome": {"key": "go", "value": 7}, "after": "n"})

    def test_a_failed_child_winner_raises_step_failed(self):
        ctx = WorkflowContext(
            "r1",
            [{"seq": 0, "kind": "any", "name": "race", "output": {"key": "kid"},
              "error": {"message": "boom"}}],
        )
        with self.assertRaises(StepFailed):
            ctx.wait_for_any("race", {"kid": ctx.child_wait("c1")})

    def test_another_name_at_the_position_is_nondeterminism(self):
        ctx = WorkflowContext(
            "r1", [{"seq": 0, "kind": "any", "name": "race", "output": {"key": "go"}}]
        )
        with self.assertRaises(NondeterminismError):
            ctx.wait_for_any("renamed", {"go": ctx.signal_wait("go")})

    def test_timer_takes_exactly_one_of_ms_or_until(self):
        ctx = WorkflowContext("r1", [])
        with self.assertRaises(ValueError):
            ctx.timer()
        with self.assertRaises(ValueError):
            ctx.timer(10, until=20)

    def test_needs_a_condition(self):
        ctx = WorkflowContext("r1", [])
        with self.assertRaises(ValueError):
            ctx.wait_for_any("race", {})


if __name__ == "__main__":
    unittest.main()
