"""Memory admission control + the "current, not peak" memory numerator.

The regression these tests lock down (flip, dev, 2026-09-17): a worker with ``concurrency="adaptive"``
running ML handlers that each build a few hundred MB of DuckDB panel was OOM-killed three times, and
the controller made it worse rather than better:

* the numerator was ``getrusage().ru_maxrss`` — a PEAK that never falls, so the brake fired late and
  then stayed on for the life of the process (the worker latched at ``min`` even when idle);
* crossing the ceiling shrank the limit ``* 0.8`` per tick, which an allocation that doubles usage in
  seconds simply outruns;
* nothing ever asked "is there room for one more right now?" before starting the next step.

So: usage is read from cgroup ``memory.current`` (working set), the brake is asymmetric (collapse at
once, grow only after sustained headroom), and a step waits at an admission gate instead of being
started into an OOM. A deferred step is never a failed step.
"""

import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

from durable_worker import Worker
from durable_worker.adaptive import (
    AdaptiveController,
    cgroup_v2_memory_dir,
    probe_memory_usage,
    resolve_concurrency,
    _read_cgroup_memory_limit,
)
from durable_worker.redis_runner import run_redis_worker

LIMIT = 1000  # a 1000-byte "container" makes every percentage in these tests readable


class FakeMemory:
    """A memory reader the test drives: ``mem.usage = 900`` and the controller sees 90%."""

    def __init__(self, usage: int = 0) -> None:
        self.usage = usage
        self.reads = 0

    def __call__(self):
        self.reads += 1
        return self.usage


def controller(mem: FakeMemory, probed: bool = True, **overrides) -> AdaptiveController:
    config = resolve_concurrency({"min": 1, "max": 8, "start": 8, "tickMs": 10, **overrides})
    ctl = AdaptiveController(
        config,
        rss_reader=mem,
        rss_limit_reader=lambda: LIMIT,
        peak_reader=lambda: None,
    )
    # By default pretend the process has already run (and measured) one task — the "first task runs
    # alone" probe has its own test, and every other test wants to start from a parallel worker.
    ctl._probe_pending = not probed
    return ctl


def fill(ctl: AdaptiveController, count: int, name: str = "handle_FAILURE_RISK") -> list:
    """Admit ``count`` tasks (asserting each one was actually admitted) and return their tokens."""
    tokens = []
    for _ in range(count):
        assert ctl.try_admit(name), "expected the gate to admit while filling"
        tokens.append(ctl.on_start(name))
    return tokens


def complete(ctl: AdaptiveController, tokens, duration_ms: float = 100.0) -> None:
    for token in tokens:
        ctl.on_settle(duration_ms, True, "step", token)


class AdmissionGateTest(unittest.TestCase):
    def test_stops_admitting_before_the_ceiling(self):
        mem = FakeMemory(100)  # 10%
        ctl = controller(mem)
        fill(ctl, 2)

        mem.usage = 700  # 70% — under the 75% admit mark
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))
        ctl.on_start("handle_FAILURE_RISK")

        # 80% is still BELOW the 85% RAM ceiling: the gate refuses before the brake ever has to fire,
        # which is the whole point — the brake only helps the steps that haven't started yet.
        mem.usage = 800
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))
        self.assertLess(mem.usage / LIMIT * 100, ctl.config.ram_ceiling_pct)

    def test_zero_in_flight_always_admits(self):
        # The anti-deadlock rule: a worker with nothing running cannot free the memory it would be
        # waiting for, so it admits one no matter how bad the reading is.
        mem = FakeMemory(LIMIT * 10)
        ctl = controller(mem)
        self.assertEqual(ctl.in_flight, 0)
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_zero_in_flight_admits_even_after_the_gate_latched(self):
        mem = FakeMemory(100)
        ctl = controller(mem)
        tokens = fill(ctl, 2)
        mem.usage = 950
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))
        complete(ctl, tokens)
        self.assertEqual(ctl.in_flight, 0)
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_hysteresis_needs_the_resume_mark_not_just_the_admit_mark(self):
        mem = FakeMemory(100)
        ctl = controller(mem)
        fill(ctl, 2)
        mem.usage = 800  # over admit (75%) -> latch
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))
        mem.usage = 700  # back under admit but NOT under resume (65%) -> still closed
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))
        mem.usage = 600  # under resume -> open again
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_a_collapsed_limit_gates_jobs_bullmq_already_fetched(self):
        mem = FakeMemory(100)
        ctl = controller(mem)
        fill(ctl, 2)
        ctl.limit = 2  # the brake just collapsed the limit; BullMQ may still hand us fetched jobs
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))

    def test_reserves_the_cost_of_steps_already_admitted(self):
        # The stampede: N jobs of the same handler arrive together, all read the same low usage, all
        # get admitted, and only then do they allocate. Reservations close that window.
        mem = FakeMemory(100)
        ctl = controller(mem)

        # Teach the controller what this handler costs, from a run where it was alone (300 bytes).
        token = ctl.on_start("handle_MEL_SHORTFALL")
        mem.usage = 400
        ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl._step_cost("handle_MEL_SHORTFALL"), 300)

        mem.usage = 100  # idle again: 10% used, 90% free — a pure usage gate would admit everything
        self.assertTrue(ctl.try_admit("handle_MEL_SHORTFALL"))
        ctl.on_start("handle_MEL_SHORTFALL")
        self.assertTrue(ctl.try_admit("handle_MEL_SHORTFALL"))
        ctl.on_start("handle_MEL_SHORTFALL")
        # 100 idle + 3 x 300 reserved = 1000 > the 750 admit mark, even though nothing has allocated
        # yet. Without the reservation this third step would be admitted straight into an OOM.
        self.assertFalse(ctl.try_admit("handle_MEL_SHORTFALL"))

    def test_a_handler_that_nearly_fills_the_container_runs_alone(self):
        # The flip case in miniature: one step whose observed cost is most of the container. The gate
        # serializes it (and the zero-in-flight rule still guarantees forward progress).
        mem = FakeMemory(50)
        ctl = controller(mem)
        token = ctl.on_start("handle_FAILURE_RISK")
        mem.usage = 700
        ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl._step_cost("handle_FAILURE_RISK"), 650)

        mem.usage = 50
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))
        ctl.on_start("handle_FAILURE_RISK")
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))

    def test_the_first_task_of_a_process_runs_alone(self):
        # With zero measurements a step's cost is invisible at admission time (it allocates AFTER it
        # starts), so a fresh pod handed 9 jobs would admit them all. One task is measured first; the
        # wait is bounded by that one settle, not by a timer.
        mem = FakeMemory(100)
        ctl = controller(mem, probed=False)
        token = ctl.on_start("handle_FAILURE_RISK")
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))
        mem.usage = 200
        ctl.on_settle(100.0, True, "step", token)
        ctl.on_start("handle_FAILURE_RISK")
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_cheap_steps_run_in_parallel_once_one_has_been_measured(self):
        # A worker whose steps cost ~nothing must not be throttled: after the first measurement the
        # reservation is ~0 and the gate is a pure usage check again.
        mem = FakeMemory(100)
        ctl = controller(mem, probed=False)
        token = ctl.on_start("cheap.step")
        ctl.on_settle(1.0, True, "step", token)
        fill(ctl, 5, name="cheap.step")
        self.assertEqual(ctl.in_flight, 5)

    def test_an_unknown_name_is_charged_the_largest_cost_we_have_measured(self):
        mem = FakeMemory(100)
        ctl = controller(mem)
        token = ctl.on_start("handle_FAILURE_RISK")
        mem.usage = 500
        ctl.on_settle(100.0, True, "step", token)
        mem.usage = 100
        # Never seen "handle_MVR", but this worker is known to run 400-byte steps — charge that rather
        # than 0 (optimistic) or an invented constant.
        self.assertEqual(ctl._step_cost("handle_MVR"), 400)
        ctl.on_start("handle_MVR")
        self.assertFalse(ctl.try_admit("handle_MVR"))

    def test_an_in_flight_workflow_turn_does_not_reserve_memory(self):
        # A workflow turn is a replay that suspends — cheap by construction, and it is not gated either
        # (see the runner). Charging it the max known step cost would let a turn block real steps.
        mem = FakeMemory(100)
        ctl = controller(mem)
        token = ctl.on_start("handle_FAILURE_RISK")
        mem.usage = 500
        ctl.tick()  # samples the 400-byte growth...
        mem.usage = 100  # ...which the handler frees before it returns
        ctl.on_settle(100.0, True, "step", token)
        ctl.on_start(None)  # a workflow turn
        self.assertEqual(ctl._step_cost(None), 0)
        self.assertTrue(ctl.try_admit("cheap.step"))

    def test_opting_out_admits_unconditionally(self):
        mem = FakeMemory(LIMIT)
        ctl = controller(mem, ramAdmission=False)
        fill(ctl, 3)
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_a_fixed_worker_is_never_gated(self):
        ctl = AdaptiveController(
            resolve_concurrency(4), rss_reader=FakeMemory(LIMIT), rss_limit_reader=lambda: LIMIT
        )
        ctl.on_start("handle_FAILURE_RISK")
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_unreadable_memory_never_gates(self):
        # A host where we can measure nothing must behave exactly as it did before the gate existed.
        ctl = controller(FakeMemory(0), probed=False, ramAdmission=True)
        ctl._rss_reader = lambda: None
        fill(ctl, 4)
        self.assertEqual(ctl.in_flight, 4)

    def test_a_workflow_turn_settling_does_not_retire_the_first_task_probe(self):
        # On a unified worker the first settle may be a workflow turn, which teaches us nothing
        # (nameless, and cost learning is step-only). Retiring the probe on it would let steps
        # parallelise with zero cost data — the fresh-pod stampede the probe exists to prevent.
        mem = FakeMemory(100)
        ctl = controller(mem, probed=False)
        turn = ctl.on_start(None)
        ctl.on_settle(5.0, True, "workflow", turn)
        step = ctl.on_start("handle_FAILURE_RISK")
        self.assertFalse(ctl.try_admit("handle_FAILURE_RISK"))
        mem.usage = 300
        ctl.on_settle(100.0, True, "step", step)
        ctl.on_start("handle_FAILURE_RISK")
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_a_reader_that_raises_is_treated_as_unreadable(self):
        def boom():
            raise OSError("cgroup went away")

        ctl = controller(FakeMemory(0))
        ctl._rss_reader = boom
        ctl.on_start("handle_FAILURE_RISK")
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))
        ctl.tick()  # and the control loop survives it too


class AsymmetricBrakeTest(unittest.TestCase):
    def test_crossing_the_ceiling_collapses_the_limit_in_one_move(self):
        mem = FakeMemory(100)
        ctl = controller(mem)
        fill(ctl, 8)
        self.assertEqual(ctl.limit, 8)
        mem.usage = 900  # 90% >= the 85% ceiling
        ctl.tick()
        # Not 8*0.8 = 6: memory is not a signal you walk down 20% at a time.
        self.assertEqual(ctl.limit, ctl.config.min)
        self.assertEqual(ctl._last_adjust["reason"], "ram_ceiling")
        self.assertEqual(ctl._last_adjust["from"], 8)

    def test_growing_back_needs_sustained_headroom(self):
        mem = FakeMemory(900)
        ctl = controller(mem, growHeadroomTicks=3)
        token = ctl.on_start("handle_SUBWO")
        ctl.tick()  # over the ceiling -> collapse
        self.assertEqual(ctl.limit, 1)

        # Memory is freed. Keep the worker saturated and completing (a healthy latency gradient, no
        # stall) so growth is gated ONLY by the headroom requirement.
        mem.usage = 200
        limits = []
        for _ in range(3):
            ctl.on_settle(100.0, True, "step", token)
            token = ctl.on_start("handle_SUBWO")
            ctl.tick()
            limits.append(ctl.limit)
        self.assertEqual(limits, [1, 1, 2])  # two ticks of patience, then +1

    def test_a_spike_that_frees_does_not_latch_the_worker_at_min(self):
        # THE peak-vs-current regression. With ru_maxrss as the numerator the reading never fell, so
        # after one spike the worker stayed at min for the life of the process.
        mem = FakeMemory(100)
        ctl = controller(mem, growHeadroomTicks=2)
        token = ctl.on_start("handle_FAILURE_RISK")
        mem.usage = 950
        ctl.tick()
        self.assertEqual(ctl.limit, 1)
        self.assertEqual(ctl.snapshot()["memory"]["gate"], "deferring")

        mem.usage = 120  # the panel was freed
        for _ in range(4):
            ctl.on_settle(100.0, True, "step", token)
            token = ctl.on_start("handle_FAILURE_RISK")
            ctl.tick()
        ctl.on_settle(100.0, True, "step", token)
        self.assertGreater(ctl.limit, ctl.config.min)  # recovered — not latched for the process's life
        self.assertEqual(ctl.snapshot()["memory"]["gate"], "open")
        self.assertTrue(ctl.try_admit("handle_FAILURE_RISK"))

    def test_usage_between_the_marks_neither_brakes_nor_grows(self):
        mem = FakeMemory(800)  # over resume, under the ceiling
        ctl = controller(mem, start=4, growHeadroomTicks=1)
        token = ctl.on_start("handle_SUBWO")
        for _ in range(10):
            ctl.on_settle(100.0, True, "step", token)
            token = ctl.on_start("handle_SUBWO")
        before = ctl.limit
        ctl.tick()
        self.assertLessEqual(ctl.limit, before)  # never grows without headroom


class StepCostLearningTest(unittest.TestCase):
    def test_learns_from_a_solo_run_only(self):
        mem = FakeMemory(100)
        ctl = controller(mem)

        solo = ctl.on_start("handle_FAILURE_RISK")
        mem.usage = 500
        ctl.on_settle(100.0, True, "step", solo)
        self.assertEqual(ctl._step_cost("handle_FAILURE_RISK"), 400)

        # Two overlapping steps: attribution would be a guess, and an inflated guess serializes the
        # worker forever — so nothing is learned from them.
        mem.usage = 100
        a = ctl.on_start("handle_MEL_SHORTFALL")
        b = ctl.on_start("handle_MEL_SHORTFALL")
        mem.usage = 900
        ctl.on_settle(100.0, True, "step", a)
        ctl.on_settle(100.0, True, "step", b)
        self.assertNotIn("handle_MEL_SHORTFALL", ctl._step_costs)

    def test_picks_up_a_peak_that_was_freed_before_the_step_settled(self):
        # Allocated and freed between two ticks: usage at settle shows nothing, but the process peak
        # moved — the one place a PEAK is the right question to ask.
        peaks = [1000, 1600]
        mem = FakeMemory(100)
        config = resolve_concurrency({"min": 1, "max": 4, "tickMs": 10})
        ctl = AdaptiveController(
            config,
            rss_reader=mem,
            rss_limit_reader=lambda: LIMIT,
            peak_reader=lambda: peaks.pop(0) if peaks else 1600,
        )
        token = ctl.on_start("handle_MVR")
        ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl._step_cost("handle_MVR"), 600)

    def test_a_peak_reader_that_raises_never_fails_the_step(self):
        # on_start/on_settle bracket the handler (on_settle runs in the runner's `finally`), so a
        # host-injected reader that throws must not propagate and mask the handler's outcome.
        def boom():
            raise OSError("no rusage here")

        config = resolve_concurrency({"min": 1, "max": 4, "tickMs": 10})
        ctl = AdaptiveController(
            config, rss_reader=FakeMemory(100), rss_limit_reader=lambda: LIMIT, peak_reader=boom
        )
        token = ctl.on_start("handle_MVR")
        ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl.in_flight, 0)
        self.assertEqual(ctl._step_cost("handle_MVR"), 0)

    def test_samples_growth_on_every_tick(self):
        mem = FakeMemory(100)
        ctl = controller(mem)
        token = ctl.on_start("handle_MX")
        mem.usage = 700  # peaks mid-run...
        ctl.tick()
        mem.usage = 150  # ...and is mostly freed before it settles
        ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl._step_cost("handle_MX"), 600)

    def test_a_rolling_window_forgets_a_one_off_overestimate(self):
        mem = FakeMemory(0)
        ctl = controller(mem)
        for usage in (900, 100, 100, 100, 100, 100):
            mem.usage = 0
            token = ctl.on_start("handle_SUBWO")
            mem.usage = usage
            ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl._step_cost("handle_SUBWO"), 100)

    def test_cost_tracking_can_be_turned_off(self):
        mem = FakeMemory(100)
        ctl = controller(mem, stepCostTracking=False)
        token = ctl.on_start("handle_FAILURE_RISK")
        mem.usage = 500
        ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl._step_cost("handle_FAILURE_RISK"), 0)
        self.assertNotIn("stepCostBytes", ctl.snapshot()["memory"])


class InFlightAccountingTest(unittest.TestCase):
    def test_settle_without_a_token_still_decrements(self):
        # Backward compatibility with an integration that predates tokens.
        ctl = controller(FakeMemory(100))
        ctl.on_start()
        ctl.on_start()
        self.assertEqual(ctl.in_flight, 2)
        ctl.on_settle(10.0, True)
        self.assertEqual(ctl.in_flight, 1)
        ctl.on_settle(10.0, True)
        self.assertEqual(ctl.in_flight, 0)
        ctl.on_settle(10.0, True)  # extra settle must not go negative
        self.assertEqual(ctl.in_flight, 0)

    def test_workflow_turns_do_not_pollute_the_latency_window(self):
        ctl = controller(FakeMemory(100))
        token = ctl.on_start()
        ctl.on_settle(5.0, True, "workflow", token)
        self.assertEqual(len(ctl._window), 0)
        self.assertEqual(ctl.in_flight, 0)


class AwaitAdmissionTest(unittest.IsolatedAsyncioTestCase):
    async def test_defers_then_admits_when_memory_frees(self):
        mem = FakeMemory(100)
        ctl = controller(mem, admissionPollMs=1)
        fill(ctl, 2)
        mem.usage = 900

        async def free_it():
            await asyncio.sleep(0.02)
            mem.usage = 100

        asyncio.ensure_future(free_it())
        admitted = await asyncio.wait_for(ctl.await_admission("handle_FAILURE_RISK"), 5)
        self.assertTrue(admitted)
        self.assertGreaterEqual(ctl._deferrals, 1)
        self.assertEqual(ctl._waiting, 0)

    async def test_admits_immediately_when_there_is_headroom(self):
        ctl = controller(FakeMemory(100), admissionPollMs=1)
        self.assertTrue(await ctl.await_admission("handle_FAILURE_RISK"))
        self.assertEqual(ctl._deferrals, 0)

    async def test_gives_up_when_the_run_is_cancelled(self):
        mem = FakeMemory(100)
        ctl = controller(mem, admissionPollMs=1)
        fill(ctl, 2)
        mem.usage = 900
        cancelled = {"v": False}

        async def cancel_it():
            await asyncio.sleep(0.02)
            cancelled["v"] = True

        asyncio.ensure_future(cancel_it())
        admitted = await asyncio.wait_for(
            ctl.await_admission("handle_FAILURE_RISK", abort=lambda: cancelled["v"]), 5
        )
        self.assertFalse(admitted)  # the caller runs it anyway; a cancelled step returns at once

    async def test_a_bounded_wait_does_not_strand_the_task(self):
        mem = FakeMemory(100)
        ctl = controller(mem, admissionPollMs=1, admissionMaxWaitMs=10)
        fill(ctl, 2)
        mem.usage = 900
        admitted = await asyncio.wait_for(ctl.await_admission("handle_FAILURE_RISK"), 5)
        self.assertFalse(admitted)

    async def test_draining_releases_the_waiters_so_shutdown_is_not_held_up(self):
        # A waiter hasn't returned from `process`, so BullMQ's close() would wait on it. Draining bounds
        # shutdown by a task duration instead of by "whenever memory frees".
        mem = FakeMemory(100)
        ctl = controller(mem, admissionPollMs=1)
        fill(ctl, 2)
        mem.usage = 900
        waiter = asyncio.ensure_future(ctl.await_admission("handle_FAILURE_RISK"))
        await asyncio.sleep(0.01)
        self.assertFalse(waiter.done())
        ctl.begin_drain()
        self.assertFalse(await asyncio.wait_for(waiter, 5))

    async def test_waiting_is_visible_on_the_heartbeat(self):
        mem = FakeMemory(100)
        ctl = controller(mem, admissionPollMs=1)
        fill(ctl, 2)
        mem.usage = 900
        waiter = asyncio.ensure_future(ctl.await_admission("handle_FAILURE_RISK"))
        await asyncio.sleep(0.02)
        snapshot = ctl.snapshot()
        self.assertEqual(snapshot["memory"]["gate"], "deferring")
        self.assertEqual(snapshot["memory"]["waiting"], 1)
        mem.usage = 100
        await asyncio.wait_for(waiter, 5)


class SnapshotTest(unittest.TestCase):
    def test_reports_current_usage_and_where_it_came_from(self):
        mem = FakeMemory(400)
        ctl = controller(mem)
        status = ctl.snapshot()
        self.assertEqual(status["rssBytes"], 400)
        self.assertEqual(status["rssLimitBytes"], LIMIT)
        self.assertAlmostEqual(status["rssPct"], 40.0)
        self.assertEqual(status["memory"]["source"], "custom")
        self.assertEqual(status["memory"]["admitPct"], 75.0)
        self.assertEqual(status["memory"]["resumePct"], 65.0)

        mem.usage = 100  # rssBytes FOLLOWS usage down — it is not a high-water mark any more
        self.assertEqual(ctl.snapshot()["rssBytes"], 100)

    def test_publishes_what_it_learned_per_step_name(self):
        mem = FakeMemory(100)
        ctl = controller(mem)
        token = ctl.on_start("handle_FAILURE_RISK")
        mem.usage = 600
        ctl.on_settle(100.0, True, "step", token)
        self.assertEqual(ctl.snapshot()["memory"]["stepCostBytes"], {"handle_FAILURE_RISK": 500})

    def test_a_fixed_worker_still_reports_memory_without_gate_fields(self):
        ctl = AdaptiveController(
            resolve_concurrency(2), rss_reader=FakeMemory(300), rss_limit_reader=lambda: LIMIT
        )
        memory = ctl.snapshot()["memory"]
        self.assertEqual(memory["source"], "custom")
        self.assertNotIn("gate", memory)


class ResolveConcurrencyTest(unittest.TestCase):
    def test_adaptive_defaults_are_the_safe_ones(self):
        config = resolve_concurrency("adaptive")
        self.assertTrue(config.ram_admission)
        self.assertEqual(config.ram_admit_pct, 75.0)
        self.assertEqual(config.ram_resume_pct, 65.0)
        self.assertEqual(config.admission_poll_ms, 250)
        self.assertEqual(config.admission_max_wait_ms, 0)
        self.assertEqual(config.grow_headroom_ticks, 3)
        self.assertTrue(config.subtract_page_cache)
        self.assertTrue(config.step_cost_tracking)

    def test_accepts_camel_case_and_snake_case(self):
        camel = resolve_concurrency({"ramAdmitPct": 50, "growHeadroomTicks": 5})
        snake = resolve_concurrency({"ram_admit_pct": 50, "grow_headroom_ticks": 5})
        self.assertEqual(camel.ram_admit_pct, 50.0)
        self.assertEqual(snake.ram_admit_pct, 50.0)
        self.assertEqual(camel.grow_headroom_ticks, 5)
        self.assertEqual(snake.grow_headroom_ticks, 5)

    def test_marks_are_ordered_resume_admit_ceiling(self):
        config = resolve_concurrency({"ramCeilingPct": 60, "ramAdmitPct": 90, "ramResumePct": 95})
        self.assertEqual(config.ram_admit_pct, 60.0)  # clamped to the ceiling
        self.assertEqual(config.ram_resume_pct, 60.0)  # clamped to the admit mark

    def test_admission_can_be_disabled(self):
        self.assertFalse(resolve_concurrency({"ramAdmission": False}).ram_admission)

    def test_a_fixed_int_is_unchanged(self):
        config = resolve_concurrency(6)
        self.assertEqual((config.mode, config.limit, config.min, config.max), ("fixed", 6, 6, 6))


class MemoryReaderTest(unittest.TestCase):
    """The reader ladder: cgroup v2 -> cgroup v1 -> /proc/self/status -> ru_maxrss (last resort)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, *parts, body):
        path = os.path.join(self.tmp.name, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="ascii") as handle:
            handle.write(body)
        return path

    def missing(self, name="nope"):
        return os.path.join(self.tmp.name, name)

    # -- cgroup v2 ------------------------------------------------------------------------------
    def test_cgroup_v2_subtracts_reclaimable_page_cache(self):
        self.write("v2", "memory.current", body="500\n")
        self.write("v2", "memory.stat", body="anon 200\ninactive_file 200\nactive_file 50\n")
        usage, source = probe_memory_usage(v2_dir=os.path.join(self.tmp.name, "v2"))
        # inactive_file is clean, reclaimable cache: the kernel drops it instead of OOM-killing, and
        # this is the same "working set" kubelet evicts on. active_file is NOT subtracted.
        self.assertEqual(usage, 300)
        self.assertEqual(source, "cgroup_v2_working_set")

    def test_cgroup_v2_raw_charge_when_cache_subtraction_is_off(self):
        self.write("v2", "memory.current", body="500\n")
        self.write("v2", "memory.stat", body="inactive_file 200\n")
        usage, source = probe_memory_usage(
            v2_dir=os.path.join(self.tmp.name, "v2"), subtract_page_cache=False
        )
        self.assertEqual(usage, 500)
        self.assertEqual(source, "cgroup_v2_current")

    def test_cgroup_v2_without_a_stat_file_uses_the_raw_charge(self):
        self.write("v2", "memory.current", body="500\n")
        usage, source = probe_memory_usage(v2_dir=os.path.join(self.tmp.name, "v2"))
        self.assertEqual((usage, source), (500, "cgroup_v2_current"))

    # -- cgroup v1 ------------------------------------------------------------------------------
    def test_falls_back_to_cgroup_v1(self):
        self.write("v1", "memory.usage_in_bytes", body="400\n")
        self.write("v1", "memory.stat", body="total_inactive_file 100\n")
        usage, source = probe_memory_usage(v2_dir=None, v1_root=os.path.join(self.tmp.name, "v1"))
        self.assertEqual((usage, source), (300, "cgroup_v1_working_set"))

    # -- no cgroup ------------------------------------------------------------------------------
    def test_falls_back_to_proc_vmrss(self):
        status = self.write("status", body="Name:\tpython\nVmPeak:\t900 kB\nVmRSS:\t2048 kB\n")
        usage, source = probe_memory_usage(
            v2_dir=None, v1_root=self.missing("v1"), proc_status=status
        )
        self.assertEqual((usage, source), (2048 * 1024, "proc_vmrss"))

    def test_last_resort_is_the_process_peak(self):
        usage, source = probe_memory_usage(
            v2_dir=None, v1_root=self.missing("v1"), proc_status=self.missing("status")
        )
        self.assertEqual(source, "rusage_maxrss_peak")
        self.assertGreater(usage, 0)

    def test_neither_cgroup_nor_proc_nor_rusage(self):
        with patch("durable_worker.adaptive._read_process_peak_rss", lambda: None):
            usage, source = probe_memory_usage(
                v2_dir=None, v1_root=self.missing("v1"), proc_status=self.missing("status")
            )
        self.assertIsNone(usage)
        self.assertEqual(source, "unavailable")

    # -- the ceiling (denominator) --------------------------------------------------------------
    def test_limit_prefers_cgroup_v2_memory_max(self):
        self.write("v2", "memory.max", body="4096\n")
        self.assertEqual(
            _read_cgroup_memory_limit(v2_dir=os.path.join(self.tmp.name, "v2")), 4096
        )

    def test_limit_falls_back_to_cgroup_v1(self):
        self.write("v2", "memory.max", body="max\n")  # cgroup v2, but no limit set
        self.write("v1", "memory.limit_in_bytes", body="2048\n")
        limit = _read_cgroup_memory_limit(
            v2_dir=os.path.join(self.tmp.name, "v2"), v1_root=os.path.join(self.tmp.name, "v1")
        )
        self.assertEqual(limit, 2048)

    def test_limit_treats_the_unlimited_sentinel_as_no_limit(self):
        self.write("v1", "memory.limit_in_bytes", body="9223372036854771712\n")
        limit = _read_cgroup_memory_limit(
            v2_dir=None, v1_root=os.path.join(self.tmp.name, "v1")
        )
        self.assertIsNotNone(limit)  # host total
        self.assertLess(limit, 1 << 62)

    def test_limit_falls_back_to_the_host_total_with_no_cgroup_at_all(self):
        limit = _read_cgroup_memory_limit(v2_dir=None, v1_root=self.missing("v1"))
        self.assertIsNotNone(limit)
        self.assertGreater(limit, 0)

    # -- which cgroup v2 directory --------------------------------------------------------------
    def test_prefers_the_mount_root_when_it_holds_the_memory_files(self):
        self.write("root", "memory.current", body="1\n")
        self.assertEqual(
            cgroup_v2_memory_dir(root=os.path.join(self.tmp.name, "root")),
            os.path.join(self.tmp.name, "root"),
        )

    def test_resolves_our_own_cgroup_when_the_mount_root_is_the_root_cgroup(self):
        # Not cgroup-namespaced (a bare systemd/docker host): the mount root is the ROOT cgroup and has
        # no memory files, so follow the relative path /proc/self/cgroup reports.
        root = os.path.join(self.tmp.name, "root")
        self.write("root", "app.slice", "worker.service", "memory.current", body="1\n")
        proc = self.write("proc-cgroup", body="0::/app.slice/worker.service\n")
        self.assertEqual(
            cgroup_v2_memory_dir(root=root, proc_cgroup=proc),
            os.path.join(root, "app.slice/worker.service"),
        )

    def test_no_cgroup_v2_at_all(self):
        proc = self.write("proc-cgroup", body="11:memory:/docker/abc\n")  # v1-only host
        self.assertIsNone(cgroup_v2_memory_dir(root=self.missing("root"), proc_cgroup=proc))


class NineBasesSimulationTest(unittest.TestCase):
    """The incident, simulated: 9 jobs of one handler on one queue, each needing 300 of a 1000 limit.

    The container dies at 1000. A worker that only reacts on a control tick has already started all
    the steps by the time it notices; the gate is asked BEFORE each start, so the peak stays bounded.
    """

    def run_batch(self, **overrides) -> int:
        mem = FakeMemory(0)
        base, cost, life_ticks = 100, 300, 3
        ctl = controller(mem, probed=False, **overrides)  # a fresh pod: nothing measured yet
        running = {}  # token -> ticks left
        pending = 9
        peak = 0
        for _ in range(60):
            # Take as many jobs as BullMQ would hand us, asking the gate before each start.
            while pending and len(running) < ctl.limit and ctl.try_admit("handle_FAILURE_RISK"):
                running[ctl.on_start("handle_FAILURE_RISK")] = life_ticks
                pending -= 1
                mem.usage = base + cost * len(running)  # the handler allocates as soon as it starts
                peak = max(peak, mem.usage)
            ctl.tick()
            for token in [t for t, left in running.items() if left <= 1]:
                del running[token]
                ctl.on_settle(100.0, True, "step", token)
                mem.usage = base + cost * len(running)
            for token in running:
                running[token] -= 1
            if not pending and not running:
                break
        self.assertEqual(pending, 0, "every job must eventually run — the gate defers, it never drops")
        return peak

    def test_the_gate_keeps_the_peak_under_the_container_limit(self):
        peak = self.run_batch()
        self.assertLess(peak, LIMIT, f"peak {peak} would have been an OOM kill")

    def test_without_the_gate_the_same_batch_would_be_oom_killed(self):
        peak = self.run_batch(ramAdmission=False)
        self.assertGreater(peak, LIMIT)


class _FakeQueue:
    def __init__(self, name, _opts):
        self.name = name
        self.added = []

    async def add(self, name, payload, _opts=None):
        self.added.append((name, payload))


class _FakeBullWorker:
    """Fake BullMQ Worker: captures the runner's process callback so a test can drive a job."""

    last = None

    def __init__(self, name, process, opts):
        self.name = name
        self.process = process
        self.opts = opts
        _FakeBullWorker.last = self

    def on(self, *_a, **_k):
        return None

    async def close(self):
        return None


class _FakeJob:
    def __init__(self, data):
        self.data = data
        self.id = data.get("stepId")


async def _noop(*_a, **_k):
    return None


class DeferredStepIsNotAFailedStepTest(unittest.IsolatedAsyncioTestCase):
    """End-to-end through the real Redis runner: the gate DEFERS a step, it does not reject it."""

    async def test_a_deferred_step_still_completes(self):
        worker = Worker(auto_register=False)

        @worker.step("handle_FAILURE_RISK")
        def handler(data):
            return {"score": data["base"]}

        mem = FakeMemory(900)  # no headroom at all
        controllers = []

        class _Controller(AdaptiveController):
            def __init__(self, config, **kwargs):
                super().__init__(
                    config, rss_reader=mem, rss_limit_reader=lambda: LIMIT, peak_reader=lambda: None
                )
                controllers.append(self)

        patches = [
            patch("bullmq.Queue", _FakeQueue),
            patch("bullmq.Worker", _FakeBullWorker),
            patch("durable_worker.redis_runner.AdaptiveController", _Controller),
            patch("durable_worker.redis_runner._verify_connection", _noop),
            patch("durable_worker.redis_runner._start_heartbeat", _noop),
            patch("durable_worker.redis_runner._subscribe_control", _noop),
            patch("durable_worker.redis_runner._progress_publisher", _noop),
            patch("durable_worker.redis_runner.AdaptiveController.start", lambda self, **_k: None),
        ]
        for p in patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in patches])

        await run_redis_worker(
            worker,
            concurrency={"min": 1, "max": 4, "start": 4, "admissionPollMs": 1, "tickMs": 10},
        )
        process = _FakeBullWorker.last.process
        ctl = controllers[0]

        def job(seq):
            return _FakeJob(
                {
                    "runId": "r1",
                    "seq": seq,
                    "stepId": f"r1:{seq}",
                    "name": "handle_FAILURE_RISK",
                    "group": "handle_FAILURE_RISK",
                    "input": {"base": seq},
                    "attempt": 1,
                }
            )

        # The first job goes straight through (nothing in flight -> always admit).
        first = await asyncio.wait_for(process(job(0), "t0"), 5)
        self.assertEqual(first["status"], "completed")

        # Now hold one step in flight and send a second job while memory is exhausted: it must WAIT,
        # not fail. Freeing memory lets it through with a normal completed result.
        held = ctl.on_start("handle_FAILURE_RISK")
        second = asyncio.ensure_future(process(job(1), "t1"))
        await asyncio.sleep(0.05)
        self.assertFalse(second.done(), "the step should be waiting at the gate, not running")
        self.assertEqual(ctl.snapshot()["memory"]["waiting"], 1)

        mem.usage = 100
        ctl.on_settle(1.0, True, "step", held)
        result = await asyncio.wait_for(second, 5)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output"], {"score": 1})
        self.assertGreaterEqual(ctl._deferrals, 1)


if __name__ == "__main__":
    unittest.main()
