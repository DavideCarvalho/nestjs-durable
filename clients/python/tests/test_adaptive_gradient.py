"""The latency gradient and the growth rule of the adaptive controller (the TS controller's twin)."""

import unittest

from durable_worker.adaptive import AdaptiveController, resolve_concurrency


def controller(**overrides) -> AdaptiveController:
    config = resolve_concurrency(
        {"min": 1, "max": 32, "start": 4, "tickMs": 10, "growHeadroomTicks": 1, **overrides}
    )
    ctl = AdaptiveController(
        config,
        rss_reader=lambda: 100,
        rss_limit_reader=lambda: 1000,
        peak_reader=lambda: None,
    )
    ctl._probe_pending = False
    return ctl


def settle(ctl: AdaptiveController, durations) -> None:
    for duration in durations:
        ctl.on_settle(float(duration), True, "step", ctl.on_start("step"))


def saturate(ctl: AdaptiveController) -> list:
    return [ctl.on_start("step") for _ in range(ctl.limit)]


def tick_over(ctl: AdaptiveController, duration_ms: float) -> None:
    """A tick over a window of 100 fresh steps of ``duration_ms`` each."""
    settle(ctl, [duration_ms] * 100)
    ctl.tick()


class GradientTest(unittest.TestCase):
    def test_fast_steps_with_jitter_do_not_shrink(self):
        ctl = controller(start=8)
        # 1–5 ms steps: the fastest is a fifth of the slowest, but none of it is queuing.
        settle(ctl, [1 + (i % 5) for i in range(100)])
        for _ in range(5):
            ctl.tick()
        self.assertEqual(ctl.limit, 8)

    def test_holds_while_p50_stays_within_twice_the_baseline(self):
        ctl = controller(start=8)
        settle(ctl, [100] + [200] * 99)  # (2 × 100 + 5) / 200 ≈ 1
        ctl.tick()
        self.assertEqual(ctl.limit, 8)

    def test_fast_steps_whose_latency_grows_past_the_noise_still_shrink(self):
        ctl = controller(start=16)
        tick_over(ctl, 1)  # the no-queuing baseline: 1 ms
        tick_over(ctl, 30)  # p50 30 ms against a baseline still near 1 ms
        self.assertEqual(ctl.limit, 12)
        self.assertEqual(ctl._last_adjust["reason"], "shrink")


class ShrinkTest(unittest.TestCase):
    def test_takes_at_most_a_quarter_off_on_one_queuing_tick(self):
        ctl = controller(start=32)
        tick_over(ctl, 1)
        tick_over(ctl, 500)  # a window of one slow moment, 500 times the baseline
        self.assertEqual(ctl.limit, 24)

    def test_keeps_shrinking_a_quarter_a_tick_while_the_latency_keeps_rising(self):
        ctl = controller(start=32, min=2)
        tick_over(ctl, 1)
        limits = []
        ms = 20.0
        for _ in range(12):
            tick_over(ctl, ms)  # each tick's p50 doubles: always past twice the baseline
            limits.append(ctl.limit)
            ms *= 2
        self.assertEqual(limits, [24, 18, 14, 11, 8, 6, 5, 4, 3, 2, 2, 2])

    def test_a_latency_that_rises_and_then_holds_becomes_the_baseline(self):
        ctl = controller(start=32)
        tick_over(ctl, 2)
        limits = []
        for _ in range(12):
            tick_over(ctl, 40)
            limits.append(ctl.limit)
        # Two cuts did not bring the latency down, so the queue is not this worker's.
        self.assertEqual(limits[:3], [24, 18, 18])
        self.assertEqual(set(limits[2:]), {18})

    def test_a_worker_held_at_one_slot_by_a_busy_shared_resource_grows(self):
        ctl = controller(start=1)
        tick_over(ctl, 2)  # a quiet moment
        for _ in range(15):
            # 40 ms a step whatever the limit: the time is spent in a shared Redis or database, and
            # now and then a step lands on a quiet moment of it.
            settle(ctl, [2, 2] + [40] * 98)
            tokens = saturate(ctl)  # every slot busy
            ctl.tick()
            for token in tokens:
                ctl.on_settle(40.0, True, "step", token)
        self.assertGreaterEqual(ctl.limit, 16)

    def test_an_idle_worker_keeps_its_limit(self):
        ctl = controller(start=32)
        tick_over(ctl, 1)
        tick_over(ctl, 500)  # the last burst ended slow: 32 → 24
        for _ in range(10):
            ctl.tick()  # then nothing runs
        self.assertEqual(ctl.limit, 24)

    def test_takes_at_least_one_slot_off_a_small_limit(self):
        ctl = controller(start=2)
        tick_over(ctl, 1)
        tick_over(ctl, 500)
        self.assertEqual(ctl.limit, 1)

    def test_is_back_at_its_level_two_ticks_after_a_one_tick_spike(self):
        ctl = controller(start=32)
        tick_over(ctl, 2)
        tick_over(ctl, 500)  # the spike: 32 → 24
        limits = [ctl.limit]
        for _ in range(2):
            settle(ctl, [2] * 100)  # healthy again
            tokens = saturate(ctl)
            ctl.tick()
            limits.append(ctl.limit)
            for token in tokens:
                ctl.on_settle(2.0, True, "step", token)
        self.assertEqual(limits, [24, 28, 32])


class GrowthTest(unittest.TestCase):
    def test_doubles_until_it_first_backs_off_then_grows_by_the_square_root(self):
        ctl = controller(start=4)
        settle(ctl, [100] * 20)
        limits = []
        for _ in range(3):
            tokens = saturate(ctl)
            ctl.tick()
            limits.append(ctl.limit)
            for token in tokens:
                ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(limits, [8, 16, 32])

        ctl = controller(start=20)
        tokens = saturate(ctl)
        for token in tokens[:10]:
            ctl.on_settle(100.0, False, "step", token)  # 50% errors → backpressure: 20 → 19
        for token in tokens[10:]:
            ctl.on_settle(100.0, True, "step", token)
        ctl.tick()
        self.assertEqual(ctl.limit, 19)
        settle(ctl, [100] * 100)  # a healthy window again
        saturate(ctl)
        ctl.tick()
        self.assertEqual(ctl.limit, 23)  # 19 + isqrt(19)


class SlowStartTest(unittest.TestCase):
    def test_grows_after_each_limit_of_settled_steps_without_waiting_for_a_tick(self):
        ctl = controller(start=4)
        settle(ctl, [2] * 10)
        ctl.tick()  # one tick of memory headroom, which growing needs
        self.assertEqual(ctl.limit, 4)  # nothing was in flight: no growth
        tokens = saturate(ctl)
        limits = []
        for _ in range(28):
            ctl.on_settle(2.0, True, "step", tokens.pop(0))
            while len(tokens) < ctl.limit:
                tokens.append(ctl.on_start("step"))
            limits.append(ctl.limit)
        self.assertEqual(sorted(set(limits)), [4, 8, 16, 32])
        self.assertEqual(limits.index(8), 3)  # the 4th settled step

    def test_never_shrinks_between_ticks(self):
        ctl = controller(start=8)
        tick_over(ctl, 1)  # the baseline: 1 ms
        tokens = saturate(ctl)
        for _ in range(60):  # enough that the window's median is the slow steps'
            ctl.on_settle(500.0, True, "step", tokens.pop(0))  # far past the tolerance
            tokens.append(ctl.on_start("step"))
        self.assertGreaterEqual(ctl.limit, 8)  # it may grow early; it never shrinks before the tick
        ctl.tick()
        self.assertEqual(ctl._last_adjust["reason"], "shrink")


if __name__ == "__main__":
    unittest.main()
