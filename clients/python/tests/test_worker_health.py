import asyncio
import unittest
from unittest import mock

from durable_worker.redis_runner import (
    _HEARTBEAT_TTL_SECONDS,
    _heartbeat_key,
    _start_heartbeat,
    _verify_connection,
)


class FakeRedis:
    """Minimal stand-in for a redis.asyncio client: records SETs, optionally fails PING."""

    def __init__(self, *, ping_error: Exception | None = None):
        self._ping_error = ping_error
        self.set_calls: list[dict] = []
        self.closed = False

    async def ping(self):
        if self._ping_error is not None:
            raise self._ping_error
        return True

    async def set(self, key, value, ex=None):
        self.set_calls.append({"key": key, "value": value, "ex": ex})
        return True

    async def aclose(self):
        self.closed = True


def _patch_from_url(client: FakeRedis):
    # The runner does `import redis.asyncio as aioredis; aioredis.from_url(...)`, so patch there.
    return mock.patch("redis.asyncio.from_url", return_value=client)


class VerifyConnectionTest(unittest.TestCase):
    def test_passes_when_ping_succeeds(self):
        client = FakeRedis()
        with _patch_from_url(client):
            asyncio.run(_verify_connection("redis://localhost:6379"))
        self.assertTrue(client.closed)  # probe connection is torn down

    def test_raises_clear_error_when_ping_fails(self):
        client = FakeRedis(ping_error=OSError("Connection refused"))
        with _patch_from_url(client), self.assertRaises(ConnectionError) as ctx:
            asyncio.run(_verify_connection("redis://localhost:6379"))
        self.assertIn("could not reach Redis", str(ctx.exception))
        self.assertTrue(client.closed)  # still closed on the failure path


class HeartbeatTest(unittest.TestCase):
    def test_stamps_ttl_keyed_by_group_and_instance(self):
        client = FakeRedis()

        async def scenario():
            with _patch_from_url(client):
                await _start_heartbeat("redis://localhost:6379", "durable", "processing-workflows")
                # Let the spawned beat() run its first SET before it parks on sleep().
                for _ in range(10):
                    await asyncio.sleep(0)
                    if client.set_calls:
                        break

        asyncio.run(scenario())

        self.assertTrue(client.set_calls, "heartbeat should have written at least once")
        first = client.set_calls[0]
        self.assertEqual(first["key"], _heartbeat_key("durable", "processing-workflows"))
        self.assertEqual(first["ex"], _HEARTBEAT_TTL_SECONDS)


if __name__ == "__main__":
    unittest.main()
