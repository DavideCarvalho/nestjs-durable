import unittest

from durable_worker import FatalError, Worker


def task(name="payments.charge-card", **over):
    base = {
        "runId": "r1",
        "seq": 0,
        "name": name,
        "stepId": "r1:0",
        "group": "payments",
        "input": {"orderId": "o1", "amountCents": 4200},
        "attempt": 1,
    }
    base.update(over)
    return base


class WorkerTest(unittest.TestCase):
    def test_runs_a_registered_sync_handler(self):
        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        def charge(data):
            return {"chargeId": f"ch_{data['orderId']}"}

        result = worker.process_task(task())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output"], {"chargeId": "ch_o1"})
        self.assertEqual(result["stepId"], "r1:0")

    def test_stamps_started_at_for_queue_wait(self):
        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        def charge(data):
            return {"chargeId": "ch_1"}

        # The worker reports when it picked the task up (epoch ms) so the engine can compute
        # queue-wait — same contract as the TypeScript runStepHandler.
        result = worker.process_task(task())
        self.assertIsInstance(result["startedAt"], int)
        self.assertGreater(result["startedAt"], 0)

    def test_awaits_async_handlers(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        async def charge(data):
            return {"chargeId": "ch_async"}

        self.assertEqual(worker.process_task(task())["output"], {"chargeId": "ch_async"})

    def test_unknown_step_is_a_non_retryable_failure(self):
        result = Worker().process_task(task(name="missing"))
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["error"]["retryable"])

    def test_handler_exception_is_a_retryable_failure(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data):
            raise RuntimeError("network blip")

        result = worker.process_task(task())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["message"], "network blip")
        self.assertNotIn("retryable", result["error"])

    def test_fatal_error_is_not_retryable(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data):
            raise FatalError("card declined", code="declined")

        result = worker.process_task(task())
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["error"]["retryable"])
        self.assertEqual(result["error"]["code"], "declined")


if __name__ == "__main__":
    unittest.main()
