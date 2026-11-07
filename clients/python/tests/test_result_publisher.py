"""Result routing and batching — parity with the TypeScript BullMQTransport's publishResult."""

import asyncio
import unittest

from durable_worker.result_publisher import (
    RESULT_BATCH_MAX,
    ResultPublisher,
    bullmq_client_name,
    count_queue_workers,
    reply_alive_key,
    reply_queue_name,
)


class FakeQueue:
    def __init__(self, name, log, fail=False, gate=None):
        self.name = name
        self.log = log
        self.fail = fail
        self.gate = gate

    async def add(self, job_name, data, opts):
        if self.gate is not None:
            await self.gate.wait()
        if self.fail:
            raise ConnectionError("refused")
        self.log.append((self.name, job_name, data))


class FakeRedis:
    def __init__(self, alive=(), batch_consumers=0, fail=False):
        self.alive = set(alive)
        self.batch_consumers = batch_consumers
        self.fail = fail
        self.exists_calls = 0
        self.client_list_calls = 0

    async def exists(self, key):
        self.exists_calls += 1
        if self.fail:
            raise ConnectionError("down")
        return 1 if key in self.alive else 0

    async def execute_command(self, *args):
        self.client_list_calls += 1
        if self.fail:
            raise ConnectionError("down")
        name = bullmq_client_name("durable-results-batch")
        lines = ["id=1 addr=x name=other cmd=ping"]
        lines += [f"id={i + 2} addr=x name={name}:w:{i} cmd=bzpopmin" for i in range(self.batch_consumers)]
        return "\n".join(lines).encode()


def make(redis=None, fail_queues=(), gate=None):
    log = []
    clock = [0.0]

    def factory(name):
        return FakeQueue(name, log, fail=name in fail_queues, gate=gate)

    pub = ResultPublisher("durable", factory, redis, clock=lambda: clock[0])
    return pub, log, clock


def result(i):
    return {"runId": "r", "seq": i, "stepId": f"s{i}", "status": "completed", "output": i}


class NamesTest(unittest.TestCase):
    def test_reply_names_match_the_typescript_transport(self):
        self.assertEqual(reply_queue_name("durable", "host:1/a"), "durable-results-to-host-1-a")
        self.assertEqual(reply_alive_key("durable", "e1"), "durable:reply-alive:e1")

    def test_counts_only_workers_on_that_queue(self):
        name = bullmq_client_name("q")
        listing = "\n".join(
            [
                f"id=1 name={name} cmd=x",
                f"id=2 name={name}:w:abc cmd=x",
                f"id=3 name={bullmq_client_name('q2')} cmd=x",
                "id=4 name= cmd=x",
            ]
        )
        self.assertEqual(count_queue_workers(listing, "q"), 2)


class PublishTest(unittest.IsolatedAsyncioTestCase):
    async def test_without_redis_one_job_per_result_on_shared_queue(self):
        pub, log, _ = make(redis=None)
        await pub.publish(result(1), "e1")
        self.assertEqual(log, [("durable-results", "result", result(1))])

    async def test_routes_to_the_live_dispatching_engine(self):
        pub, log, _ = make(redis=FakeRedis(alive={"durable:reply-alive:e1"}))
        await pub.publish(result(1), "e1")
        self.assertEqual(log, [("durable-results-to-e1", "result", result(1))])

    async def test_dead_engine_falls_back_to_shared_results(self):
        pub, log, _ = make(redis=FakeRedis())
        await pub.publish(result(1), "e1")
        self.assertEqual(log, [("durable-results", "result", result(1))])

    async def test_failed_routed_publish_falls_back(self):
        pub, log, _ = make(
            redis=FakeRedis(alive={"durable:reply-alive:e1"}), fail_queues={"durable-results-to-e1"}
        )
        await pub.publish(result(1), "e1")
        self.assertEqual(log, [("durable-results", "result", result(1))])

    async def test_liveness_is_cached_for_a_second(self):
        redis = FakeRedis(alive={"durable:reply-alive:e1"})
        pub, _, clock = make(redis=redis)
        await pub.publish(result(1), "e1")
        await pub.publish(result(2), "e1")
        self.assertEqual(redis.exists_calls, 1)
        clock[0] = 1.5
        await pub.publish(result(3), "e1")
        self.assertEqual(redis.exists_calls, 2)

    async def test_batches_while_an_engine_reads_batches(self):
        gate = asyncio.Event()
        redis = FakeRedis(batch_consumers=1)
        pub, log, _ = make(redis=redis, gate=gate)
        sends = [asyncio.ensure_future(pub.publish(result(i))) for i in range(5)]
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        gate.set()
        await asyncio.gather(*sends)
        # Results that finish while a batch is in flight share the next job: fewer jobs than results.
        self.assertLess(len(log), 5)
        self.assertTrue(all(q == "durable-results-batch" and n == "results" for q, n, _ in log))
        self.assertEqual(sum(len(d["results"]) for _, _, d in log), 5)
        self.assertEqual(redis.client_list_calls, 1)

    async def test_batch_size_is_capped(self):
        gate = asyncio.Event()
        pub, log, _ = make(redis=FakeRedis(batch_consumers=1), gate=gate)
        sends = [asyncio.ensure_future(pub.publish(result(i))) for i in range(RESULT_BATCH_MAX + 10)]
        for _ in range(3):
            await asyncio.sleep(0)
        gate.set()
        await asyncio.gather(*sends)
        self.assertTrue(all(len(d["results"]) <= RESULT_BATCH_MAX for _, _, d in log))
        self.assertEqual(sum(len(d["results"]) for _, _, d in log), RESULT_BATCH_MAX + 10)

    async def test_failed_batch_goes_out_one_job_per_result(self):
        pub, log, _ = make(
            redis=FakeRedis(batch_consumers=1), fail_queues={"durable-results-batch"}
        )
        await asyncio.gather(pub.publish(result(1)), pub.publish(result(2)))
        self.assertEqual(sorted(d["seq"] for _, _, d in log), [1, 2])
        self.assertTrue(all(q == "durable-results" and n == "result" for q, n, _ in log))

    async def test_redis_refusing_client_list_means_no_batches(self):
        pub, log, _ = make(redis=FakeRedis(fail=True))
        await pub.publish(result(1), "e1")
        self.assertEqual(log, [("durable-results", "result", result(1))])


if __name__ == "__main__":
    unittest.main()
