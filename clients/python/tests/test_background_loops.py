"""Retained background loops must not disappear quietly.

The heartbeat and the control-channel listener run for the life of the worker. If either
ends, the process keeps serving and looks healthy while a capability is gone: the worker
stops refreshing its registration, or it stops observing cancellation. Both were silent —
`_spawn_retained` dropped the dead task and said nothing.
"""

import asyncio
import io
import sys
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

from durable_worker import redis_runner as rr


class SpawnRetainedTest(unittest.IsolatedAsyncioTestCase):
    async def test_reports_a_loop_that_died_of_an_exception(self):
        async def boom():
            raise RuntimeError("redis went away")

        out = io.StringIO()
        with redirect_stdout(out):
            task = rr._spawn_retained(boom(), name="heartbeat:processing")
            with self.assertRaises(RuntimeError):
                await task
            await asyncio.sleep(0)

        printed = out.getvalue()
        self.assertIn("heartbeat:processing", printed)
        self.assertIn("RuntimeError", printed)

    async def test_reports_a_loop_that_returned_early(self):
        """A loop that ends without raising is just as gone, and was just as silent."""

        async def finishes():
            return None

        out = io.StringIO()
        with redirect_stdout(out):
            await rr._spawn_retained(finishes(), name="control-channel:durable")
            await asyncio.sleep(0)

        self.assertIn("control-channel:durable", out.getvalue())

    async def test_stays_quiet_when_cancelled(self):
        """Cancellation is the ordinary shutdown path — reporting it would be noise on every exit."""

        async def forever():
            await asyncio.sleep(3600)

        out = io.StringIO()
        with redirect_stdout(out):
            task = rr._spawn_retained(forever(), name="heartbeat:processing")
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.sleep(0)

        self.assertEqual(out.getvalue(), "")

    async def test_still_retains_the_task(self):
        """The original reason this helper exists: asyncio only holds a weak reference."""

        async def forever():
            await asyncio.sleep(3600)

        task = rr._spawn_retained(forever(), name="x")
        try:
            self.assertIn(task, rr._BACKGROUND_TASKS)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


class HeartbeatSurvivesTest(unittest.IsolatedAsyncioTestCase):
    """The heartbeat's `except` has to be wider than Exception.

    A BaseException that is not CancelledError would otherwise end the loop, and the key it
    refreshes is what makes the worker readable as registered — so the worker would consume
    nothing while still looking alive. Exercises the real `_start_heartbeat`: the library
    imports `redis.asyncio` lazily, so a stub in sys.modules is enough to drive it.
    """

    async def test_a_base_exception_does_not_end_the_loop(self):
        # Not KeyboardInterrupt/SystemExit: pytest intercepts those and would abort the run
        # instead of reporting a failure. Any BaseException makes the same point.
        class Wedged(BaseException):
            pass

        beats = {"n": 0}

        class FakeClient:
            async def set(self, *a, **k):
                beats["n"] += 1
                if beats["n"] == 1:
                    raise Wedged("not an Exception subclass")

        aio = types.ModuleType("redis.asyncio")
        aio.from_url = lambda *a, **k: FakeClient()
        pkg = types.ModuleType("redis")
        pkg.asyncio = aio

        with mock.patch.dict(sys.modules, {"redis": pkg, "redis.asyncio": aio}), \
                mock.patch.object(rr, "_HEARTBEAT_INTERVAL_SECONDS", 0):
            await rr._start_heartbeat("redis://stub", "durable", "processing")
            for _ in range(12):
                await asyncio.sleep(0)

        for task in list(rr._BACKGROUND_TASKS):
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

        self.assertGreater(
            beats["n"], 1, "the loop must keep beating after a non-Exception error"
        )


if __name__ == "__main__":
    unittest.main()
