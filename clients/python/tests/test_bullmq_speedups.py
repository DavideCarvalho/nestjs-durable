"""The bullmq per-job ``Scripts`` patch: jobs of one queue share one ``Scripts``; Lua read once."""

import unittest

from durable_worker import _bullmq_speedups


class FakeConn:
    def __init__(self):
        self.registered = 0

    def register_script(self, source):
        self.registered += 1
        return ("script", len(source))


class FakeRedisConnection:
    def __init__(self):
        self.conn = FakeConn()


class FakeQueue:
    def __init__(self, name, connection, prefix="bull"):
        self.name = name
        self.prefix = prefix
        self.qualifiedName = f"{prefix}:{name}"
        self.redisConnection = connection


class BullmqSpeedupsTest(unittest.TestCase):
    def setUp(self):
        try:
            import bullmq.job  # noqa: F401
        except ImportError:
            self.skipTest("bullmq not installed")
        self.assertTrue(_bullmq_speedups.install())

    def test_jobs_of_one_queue_share_their_scripts(self):
        from bullmq.job import Job

        connection = FakeRedisConnection()
        queue = FakeQueue("durable-results", connection)
        first = Job(queue, "result", {"a": 1})
        registered = connection.conn.registered
        second = Job(queue, "result", {"a": 2})
        self.assertIs(first.scripts, second.scripts)
        self.assertEqual(connection.conn.registered, registered)
        self.assertEqual(first.scripts.keys["wait"], "bull:durable-results:wait")

    def test_other_queues_and_connections_get_their_own(self):
        from bullmq.job import Job

        connection = FakeRedisConnection()
        a = Job(FakeQueue("q-a", connection), "x", {})
        b = Job(FakeQueue("q-b", connection), "x", {})
        c = Job(FakeQueue("q-a", FakeRedisConnection()), "x", {})
        self.assertIsNot(a.scripts, b.scripts)
        self.assertIsNot(a.scripts, c.scripts)
        self.assertEqual(b.scripts.keys["wait"], "bull:q-b:wait")

    def test_install_is_idempotent(self):
        self.assertTrue(_bullmq_speedups.install())
        self.assertTrue(_bullmq_speedups.install())


if __name__ == "__main__":
    unittest.main()
