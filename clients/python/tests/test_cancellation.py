import unittest

from durable_worker import CancellationRegistry, Cancelled, Worker


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


if __name__ == "__main__":
    unittest.main()
