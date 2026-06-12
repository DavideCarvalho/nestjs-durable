import json
import threading
import unittest

from durable_worker import Worker
from durable_worker.sqs_runner import _is_ours, _queue_names, handle_message, run_sqs_worker


def a_task(name="payments.charge-card", **over):
    base = {
        "runId": "r1", "seq": 0, "name": name, "stepId": "r1:0",
        "group": "payments", "input": {"orderId": "o1"}, "attempt": 1,
    }
    base.update(over)
    return base


class FakeSqs:
    """A minimal stand-in for a boto3 SQS client that yields one task then drains."""

    def __init__(self, messages, stop=None):
        self._messages = messages
        self._stop = stop
        self.sent = []
        self.deleted = []
        self.released = []

    def get_queue_url(self, QueueName):
        return {"QueueUrl": f"https://sqs/{QueueName}"}

    def receive_message(self, **_):
        batch, self._messages = self._messages, []
        if not batch and self._stop is not None:
            self._stop.set()  # queue drained → let the runner exit on its next loop check
        return {"Messages": batch}

    def send_message(self, **kw):
        self.sent.append(kw)

    def delete_message(self, **kw):
        self.deleted.append(kw)

    def change_message_visibility(self, **kw):
        self.released.append(kw)


class SqsRunnerTest(unittest.TestCase):
    def test_queue_names_match_the_ts_transport(self):
        self.assertEqual(_queue_names("durable", "payments"), ("durable-tasks-payments", "durable-results"))

    def test_handle_message_is_the_pure_core(self):
        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        def charge(data):
            return {"chargeId": f"ch_{data['orderId']}"}

        result = handle_message(worker, json.dumps(a_task()))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output"], {"chargeId": "ch_o1"})

    def test_processes_a_task_and_sends_the_result(self):
        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        def charge(data):
            return {"chargeId": "ch_1"}

        stop = threading.Event()
        client = FakeSqs([{"Body": json.dumps(a_task()), "ReceiptHandle": "rh1"}], stop=stop)
        # First receive yields the task; the runner processes it; second receive is empty → drains → stop.
        run_sqs_worker(worker, group="payments", client=client, stop=stop, wait_time_seconds=0,
                       tasks_queue_url="t", results_queue_url="r")
        self.assertEqual(len(client.sent), 1)
        sent_body = json.loads(client.sent[0]["MessageBody"])
        self.assertEqual(sent_body["status"], "completed")
        self.assertEqual(sent_body["output"], {"chargeId": "ch_1"})
        self.assertIn("startedAt", sent_body)
        self.assertEqual(client.deleted[0]["ReceiptHandle"], "rh1")

    def test_marker_filters_foreign_messages(self):
        mine = {"MessageAttributes": {"durable": {"StringValue": "1"}}}
        self.assertTrue(_is_ours(mine, "durable"))
        self.assertFalse(_is_ours({"MessageAttributes": {}}, "durable"))
        self.assertTrue(_is_ours({}, None))


if __name__ == "__main__":
    unittest.main()
