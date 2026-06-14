import unittest

from durable_worker import reply_target


class ReplyTargetTest(unittest.TestCase):
    def test_routes_by_task_transport_id(self):
        targets = {"redis": "redis-results", "sqs": "sqs-results"}
        self.assertEqual(reply_target({"transport": "sqs"}, targets), "sqs-results")
        self.assertEqual(reply_target({"transport": "redis"}, targets), "redis-results")

    def test_falls_back_to_the_lone_target_when_id_is_absent(self):
        self.assertEqual(reply_target({}, {"only": "x"}), "x")

    def test_unknown_id_with_multiple_targets_is_unroutable(self):
        self.assertIsNone(reply_target({"transport": "nats"}, {"redis": "a", "sqs": "b"}))

    def test_empty_targets_is_none(self):
        self.assertIsNone(reply_target({"transport": "redis"}, {}))


if __name__ == "__main__":
    unittest.main()
