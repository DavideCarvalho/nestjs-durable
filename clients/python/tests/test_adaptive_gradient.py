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
        settle(ctl, [1] + [30] * 99)  # (2 × 1 + 5) / 30 ≈ 0.23
        ctl.tick()
        self.assertEqual(ctl.limit, 3)
        self.assertEqual(ctl._last_adjust["reason"], "shrink")


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
        settle(ctl, [1])
        tokens = saturate(ctl)
        for _ in range(30):
            ctl.on_settle(500.0, True, "step", tokens.pop(0))  # far past the tolerance
            tokens.append(ctl.on_start("step"))
        self.assertEqual(ctl.limit, 8)
        ctl.tick()
        self.assertEqual(ctl._last_adjust["reason"], "shrink")


if __name__ == "__main__":
    unittest.main()
