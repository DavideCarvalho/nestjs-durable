import asyncio
import unittest

from durable_worker import (
    FatalError,
    StepContext,
    Worker,
    current_context,
    current_step,
    log,
    set_process,
    sub,
)


def task(name="payments.charge-card", **over):
    base = {
        "runId": "r1",
        "seq": 0,
        "name": name,
        "stepId": "r1:0",
        "group": "payments",
        "input": {"orderId": "o1", "amountCents": 4200},
        "attempt": 1,
    }
    base.update(over)
    return base


class WorkerTest(unittest.TestCase):
    def test_runs_a_registered_sync_handler(self):
        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        def charge(data):
            return {"chargeId": f"ch_{data['orderId']}"}

        result = worker.process_task(task())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["output"], {"chargeId": "ch_o1"})
        self.assertEqual(result["stepId"], "r1:0")

    def test_stamps_started_at_for_queue_wait(self):
        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        def charge(data):
            return {"chargeId": "ch_1"}

        # The worker reports when it picked the task up (epoch ms) so the engine can compute
        # queue-wait — same contract as the TypeScript runStepHandler.
        result = worker.process_task(task())
        self.assertIsInstance(result["startedAt"], int)
        self.assertGreater(result["startedAt"], 0)

    def test_awaits_async_handlers(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        async def charge(data):
            return {"chargeId": "ch_async"}

        self.assertEqual(worker.process_task(task())["output"], {"chargeId": "ch_async"})

    def test_unknown_step_is_a_non_retryable_failure(self):
        result = Worker().process_task(task(name="missing"))
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["error"]["retryable"])

    def test_handler_exception_is_a_retryable_failure(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data):
            raise RuntimeError("network blip")

        result = worker.process_task(task())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["message"], "network blip")
        self.assertNotIn("retryable", result["error"])

    def test_fatal_error_is_not_retryable(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data):
            raise FatalError("card declined", code="declined")

        result = worker.process_task(task())
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["error"]["retryable"])
        self.assertEqual(result["error"]["code"], "declined")


    def test_handler_without_ctx_param_omits_events(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data):
            return {"chargeId": "ch_1"}

        self.assertNotIn("events", worker.process_task(task()))

    def test_ctx_records_sub_process_outcomes_on_the_result(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            ctx.info("planned 3 procs")
            ctx.sub("proc-a", "ok")
            ctx.sub("proc-b", "failed", "validation rejected")
            ctx.sub("proc-c", "skipped")
            return {"chargeId": "ch_1"}

        result = worker.process_task(task())
        self.assertEqual(result["status"], "completed")
        events = result["events"]
        self.assertEqual(len(events), 4)
        subs = [e for e in events if "status" in e]
        self.assertEqual(
            [(e["name"], e["status"], e["level"]) for e in subs],
            [("proc-a", "ok", "info"), ("proc-b", "failed", "error"), ("proc-c", "skipped", "warn")],
        )
        self.assertTrue(all(isinstance(e["at"], int) for e in events))

    def test_events_logged_before_a_throw_survive_on_failure(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx):
            ctx.sub("proc-a", "ok")
            raise RuntimeError("blip")

        result = worker.process_task(task())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["events"][0]["name"], "proc-a")

    def test_async_handler_receives_ctx(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        async def charge(_data, ctx):
            ctx.debug("async")
            return {"ok": True}

        result = worker.process_task(task())
        self.assertEqual(result["events"][0]["message"], "async")

    def test_logs_are_tagged_with_the_current_process(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            ctx.process("proc-a")
            ctx.info("inside a")
            ctx.sub("proc-a", "ok")
            ctx.process("proc-b")
            ctx.debug("inside b")
            ctx.process(None)
            ctx.info("step-level")
            return {"ok": True}

        # process() itself emits nothing, so the events are: [info a, sub a, debug b, info step-level]
        events = worker.process_task(task())["events"]
        # log lines carry the sub-process that was running when they fired...
        self.assertEqual(events[0]["process"], "proc-a")
        self.assertEqual(events[2]["process"], "proc-b")
        # ...the sub-process OUTCOME row names itself (no `process` tag)...
        self.assertNotIn("process", events[1])
        self.assertEqual(events[1]["status"], "ok")
        # ...and a log after process(None) is untagged (step-level).
        self.assertNotIn("process", events[3])

    def test_on_event_streams_each_event_as_it_is_emitted(self):
        worker = Worker()
        live = []

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            ctx.info("first")
            # the live sink saw the event the instant it was emitted, before the step returned
            self.assertEqual([e["message"] for e in live], ["first"])
            ctx.sub("proc-a", "ok")
            return {"ok": True}

        result = worker.process_task(task(), on_event=live.append)
        self.assertEqual([e["message"] for e in live], ["first", "proc-a"])
        # the same events still ride back on the result (live-tail doesn't replace the final record)
        self.assertEqual(len(result["events"]), 2)


    def test_module_level_helpers_reach_the_current_step(self):
        worker = Worker()

        def deep_business_logic():
            # No `ctx` in scope here — the context-local helpers find it.
            set_process("proc-a")
            log("debug", "querying")
            sub("proc-a", "ok")

        @worker.step("payments.charge-card")
        def charge(_data):  # note: no ctx param — handler doesn't even take it
            deep_business_logic()
            return {"ok": True}

        events = worker.process_task(task())["events"]
        self.assertEqual(events[0]["message"], "querying")
        self.assertEqual(events[0]["process"], "proc-a")
        self.assertEqual(events[1]["name"], "proc-a")
        self.assertEqual(events[1]["status"], "ok")

    def test_module_level_helpers_are_noops_outside_a_step(self):
        # Same business code on a non-durable path must not blow up.
        self.assertIsNone(current_step())
        log("info", "no step here")
        sub("x", "ok")
        set_process("x")

    def test_blocking_handler_runs_in_a_thread_with_the_step_bound(self):
        import threading

        worker = Worker()
        ran_on = {}

        @worker.step("payments.charge-card", blocking=True)
        def charge(_data):
            ran_on["thread"] = threading.current_thread().name
            log("info", "from the worker thread")
            return {"ok": True}

        async def drive():
            return await worker.aprocess_task(task())

        loop_thread = threading.current_thread().name
        result = asyncio.run(drive())
        self.assertEqual(result["events"][0]["message"], "from the worker thread")
        # it really ran off the event-loop thread (so the lock keeps renewing)
        self.assertNotEqual(ran_on["thread"], loop_thread)


class ContextCarrierTest(unittest.TestCase):
    """The opaque context carrier (tenant / user / correlation ids) the engine stamps on a task is
    re-exposed to the handler — mirrors the TS engine's ``context`` option / ``RemoteTask.context``."""

    def test_exposes_context_to_the_handler(self):
        worker = Worker(group="payments")
        seen = {}

        @worker.step("payments.charge-card")
        def charge(data, ctx):
            seen["ctx"] = ctx.context
            seen["current"] = current_context()
            return {"ok": True}

        carrier = {"tenantId": "t1", "userRef": {"type": "User", "id": 1}}
        result = worker.process_task(task(context=carrier))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(seen["ctx"], carrier)
        self.assertEqual(seen["current"], carrier)

    def test_context_is_none_when_absent(self):
        worker = Worker(group="payments")
        seen = {}

        @worker.step("payments.charge-card")
        def charge(data, ctx):
            seen["ctx"] = ctx.context
            return {"ok": True}

        # A task without a `context` field (existing dispatchers) behaves identically.
        result = worker.process_task(task())
        self.assertEqual(result["status"], "completed")
        self.assertIsNone(seen["ctx"])

    def test_current_context_is_none_outside_a_step(self):
        self.assertIsNone(current_context())


if __name__ == "__main__":
    unittest.main()
