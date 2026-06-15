import unittest

from durable_worker import redis_url_from_env


class RedisUrlFromEnvTest(unittest.TestCase):
    def setUp(self):
        import os

        self._saved = {
            k: os.environ.pop(k, None)
            for k in ("REDIS_HOST", "REDIS_PORT", "REDIS_USERNAME", "REDIS_PASSWORD")
        }

    def tearDown(self):
        import os

        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_defaults_to_localhost_without_auth(self):
        self.assertEqual(redis_url_from_env(), "redis://localhost:6379")

    def test_host_port_and_auth(self):
        import os

        os.environ["REDIS_HOST"] = "redis.internal"
        os.environ["REDIS_PORT"] = "6380"
        self.assertEqual(redis_url_from_env(), "redis://redis.internal:6380")
        os.environ["REDIS_USERNAME"] = "default"
        os.environ["REDIS_PASSWORD"] = "secret"
        self.assertEqual(redis_url_from_env(), "redis://default:secret@redis.internal:6380")

    def test_url_encodes_credentials(self):
        import os

        os.environ["REDIS_HOST"] = "redis.internal"
        os.environ["REDIS_PORT"] = "6380"
        os.environ["REDIS_USERNAME"] = "default"
        # A password with @ : / would corrupt the netloc if left raw.
        os.environ["REDIS_PASSWORD"] = "p@ss:w/rd"
        self.assertEqual(
            redis_url_from_env(), "redis://default:p%40ss%3Aw%2Frd@redis.internal:6380"
        )


if __name__ == "__main__":
    unittest.main()
