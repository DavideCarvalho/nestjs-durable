import unittest

from durable_worker import (
    CancellationRegistry,
    Worker,
    WorkflowWorker,
    current_step,
)


def task(name="long.job", **over):
    base = {"runId": "r1", "seq": 0, "name": name, "stepId": "r1:0", "input": {}, "attempt": 1}
    base.update(over)
    return base


class CancellationRegistryTest(unittest.TestCase):
    def test_records_a_cancel_control_message(self):
        reg = CancellationRegistry()
        self.assertFalse(reg.is_cancelled("r1"))
        reg.on_control_message({"kind": "cancel", "runId": "r1", "from": "x"})
        self.assertTrue(reg.is_cancelled("r1"))

    def test_ignores_non_cancel_messages(self):
        reg = CancellationRegistry()
        reg.on_control_message({"kind": "event", "event": {}})
        reg.on_control_message({"nonsense": True})
        self.assertFalse(reg.is_cancelled("r1"))


class StepContextCancellationTest(unittest.TestCase):
    def test_handler_sees_cancellation_via_ctx(self):
        reg = CancellationRegistry()
        worker = Worker()
        observed = {}

        @worker.step("long.job")
        def run(_data, ctx):
            observed["before"] = ctx.cancelled
            reg.cancel("r1")
            observed["after"] = ctx.cancelled
            return "done"

        worker.process_task(task(), is_cancelled=reg.is_cancelled)
        self.assertEqual(observed, {"before": False, "after": True})

    def test_raise_if_cancelled_aborts_the_step(self):
        reg = CancellationRegistry()
        reg.cancel("r1")
        worker = Worker()

        @worker.step("long.job")
        def run(_data, ctx):
            ctx.raise_if_cancelled()
            return "should not get here"

        result = worker.process_task(task(), is_cancelled=reg.is_cancelled)
        self.assertEqual(result["status"], "failed")
        self.assertIn("cancelled", result["error"]["message"])

    def test_cancelled_is_false_without_a_source(self):
        worker = Worker()

        @worker.step("long.job")
        def run(_data, ctx):
            return ctx.cancelled

        result = worker.process_task(task())
        self.assertEqual(result["output"], False)


class WorkflowCancellationTest(unittest.TestCase):
    """The workflow replay path (ctx.step/ctx.call) honours cancellation: auto-abort at op
    boundaries (no `if` in user code) + cooperative `current_step().cancelled` inside a step."""

    @staticmethod
    def _task(**over):
        base = {"taskId": "t1", "runId": "r1", "workflow": "wf", "history": [], "input": {}}
        base.update(over)
        return base

    def test_auto_raises_at_the_next_op_boundary_when_cancelled(self):
        reg = CancellationRegistry()
        wf = WorkflowWorker(auto_register=False)
        ran = []

        @wf.workflow("wf")
        def body(ctx, _input):
            ctx.step("a", lambda: ran.append("a"))
            reg.cancel("r1")  # cancel fires mid-turn, after step a
            ctx.step("b", lambda: ran.append("b"))  # boundary → aborts, b never runs
            return "done"

        decision = wf.process_task(self._task(), is_cancelled=reg.is_cancelled)

        self.assertEqual(decision["status"], "cancelled")
        self.assertEqual(ran, ["a"])  # step b never executed
        # the step that DID run this turn is recorded (partial progress preserved)
        self.assertTrue(any(c.get("name") == "a" for c in decision["commands"]))
        self.assertFalse(any(c.get("name") == "b" for c in decision["commands"]))

    def test_cooperative_ctx_cancelled_inside_a_step(self):
        reg = CancellationRegistry()
        wf = WorkflowWorker(auto_register=False)
        seen = {}

        @wf.workflow("wf")
        def body(ctx, _input):
            def step_body():
                seen["before"] = current_step().cancelled
                reg.cancel("r1")
                seen["after"] = current_step().cancelled

            ctx.step("a", step_body)
            return "ok"

        wf.process_task(self._task(), is_cancelled=reg.is_cancelled)
        self.assertEqual(seen, {"before": False, "after": True})

    def test_runs_to_completion_without_a_cancel_source(self):
        wf = WorkflowWorker(auto_register=False)

        @wf.workflow("wf")
        def body(ctx, _input):
            ctx.step("a", lambda: 1)
            ctx.step("b", lambda: 2)
            return "done"

        decision = wf.process_task(self._task())
        self.assertEqual(decision["status"], "completed")
        self.assertEqual(decision["output"], "done")


if __name__ == "__main__":
    unittest.main()
