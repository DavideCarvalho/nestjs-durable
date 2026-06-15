"""Tests for the ergonomic sub-process lifecycle API: sub_process() + sub_event()."""

import unittest

from durable_worker import StepContext, Worker, sub_event, sub_process
from durable_worker.worker import _current_step


def task(name="payments.charge-card", **over):
    base = {
        "runId": "r1",
        "seq": 0,
        "name": name,
        "stepId": "r1:0",
        "group": "payments",
        "input": {"orderId": "o1"},
        "attempt": 1,
    }
    base.update(over)
    return base


class SubProcessTest(unittest.TestCase):
    # ------------------------------------------------------------------
    # 1. Lifecycle + terminal ok + log tagging
    # ------------------------------------------------------------------
    def test_lifecycle_ok_and_log_tagging(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            with sub_process("ProcessKpi", group="AF_FLEET") as sp:
                sp.phase("validating")
                sp.phase("processing")
                ctx.info("did a thing")
            return {"ok": True}

        result = worker.process_task(task())
        self.assertEqual(result["status"], "completed")
        events = result["events"]

        # Two phase events then one log then one terminal
        phase_events = [e for e in events if "phase" in e]
        self.assertEqual(len(phase_events), 2)
        self.assertEqual(phase_events[0]["phase"], "validating")
        self.assertEqual(phase_events[1]["phase"], "processing")

        # All phase events share one non-empty subId and the right group
        sub_ids = {e["subId"] for e in phase_events}
        self.assertEqual(len(sub_ids), 1)
        (sub_id,) = sub_ids
        self.assertTrue(sub_id)
        for e in phase_events:
            self.assertEqual(e.get("group"), "AF_FLEET")

        # The log line emitted inside the context manager carries the same subId
        log_events = [e for e in events if e.get("message") == "did a thing"]
        self.assertEqual(len(log_events), 1)
        self.assertEqual(log_events[0].get("subId"), sub_id)

        # Terminal event: status ok, same subId, durationMs present as non-negative int
        terminal_events = [e for e in events if e.get("status") == "ok"]
        self.assertEqual(len(terminal_events), 1)
        terminal = terminal_events[0]
        self.assertEqual(terminal.get("subId"), sub_id)
        self.assertIsInstance(terminal["data"]["durationMs"], int)
        self.assertGreaterEqual(terminal["data"]["durationMs"], 0)

    # ------------------------------------------------------------------
    # 2. Exception → failed + re-raise
    # ------------------------------------------------------------------
    def test_exception_records_failed_and_reraises(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            with sub_process("ProcessKpi"):
                raise ValueError("boom")

        result = worker.process_task(task())
        self.assertEqual(result["status"], "failed")

        events = result["events"]
        terminal_events = [e for e in events if e.get("status") == "failed"]
        self.assertEqual(len(terminal_events), 1)
        terminal = terminal_events[0]
        self.assertEqual(terminal.get("message"), "boom")
        self.assertIn("durationMs", terminal["data"])

    # ------------------------------------------------------------------
    # 3. skip → terminal skipped, no ok
    # ------------------------------------------------------------------
    def test_skip_records_skipped_and_no_ok(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            with sub_process("P") as sp:
                sp.phase("validating")
                sp.skip("bad rows")
            return {"ok": True}

        result = worker.process_task(task())
        events = result["events"]

        terminal_skipped = [e for e in events if e.get("status") == "skipped"]
        self.assertEqual(len(terminal_skipped), 1)
        self.assertEqual(terminal_skipped[0].get("message"), "bad rows")
        self.assertIn("durationMs", terminal_skipped[0]["data"])

        terminal_ok = [e for e in events if e.get("status") == "ok"]
        self.assertEqual(len(terminal_ok), 0)

    # ------------------------------------------------------------------
    # 4. Flat sub_event
    # ------------------------------------------------------------------
    def test_flat_sub_event(self):
        ctx = StepContext()
        ctx.sub_event(id="r1", name="P", group="G", phase="processing")
        ctx.sub_event(id="r1", name="P", status="ok", data={"durationMs": 42})

        events = ctx.events
        self.assertEqual(len(events), 2)

        phase_ev = events[0]
        self.assertEqual(phase_ev.get("subId"), "r1")
        self.assertEqual(phase_ev.get("group"), "G")
        self.assertEqual(phase_ev.get("phase"), "processing")
        self.assertNotIn("status", phase_ev)

        terminal_ev = events[1]
        self.assertEqual(terminal_ev.get("subId"), "r1")
        self.assertEqual(terminal_ev.get("status"), "ok")
        self.assertEqual(terminal_ev["data"]["durationMs"], 42)
        self.assertNotIn("phase", terminal_ev)

    # ------------------------------------------------------------------
    # 5. No-op outside a step
    # ------------------------------------------------------------------
    def test_noop_outside_a_step(self):
        # Ensure we're genuinely outside any step
        self.assertIsNone(_current_step.get())

        # Must not raise and must not record anything
        with sub_process("P") as sp:
            sp.phase("x")

        # sub_event module-level helper is also a no-op outside a step
        sub_event(id="r1", name="P", phase="x")

    # ------------------------------------------------------------------
    # 6. Back-compat: plain ctx.sub still works and has no subId
    # ------------------------------------------------------------------
    def test_back_compat_plain_sub(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            ctx.sub("legacy", "ok")
            return {"ok": True}

        result = worker.process_task(task())
        events = result["events"]
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev.get("name"), "legacy")
        self.assertEqual(ev.get("status"), "ok")
        self.assertNotIn("subId", ev)


    # ------------------------------------------------------------------
    # 7. Nested sub_process restores outer tagging
    # ------------------------------------------------------------------
    def test_nested_sub_process_restores_outer_tagging(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            with sub_process("Outer"):
                with sub_process("Inner"):
                    ctx.info("inner log")
                ctx.info("outer log")
            return {"ok": True}

        result = worker.process_task(task())
        self.assertEqual(result["status"], "completed")
        events = result["events"]

        # Locate the two log lines
        inner_log = next(e for e in events if e.get("message") == "inner log")
        outer_log = next(e for e in events if e.get("message") == "outer log")

        # Inner log carries Inner's subId; outer log carries Outer's subId
        inner_sub_id = inner_log.get("subId")
        outer_sub_id = outer_log.get("subId")
        self.assertTrue(inner_sub_id)
        self.assertTrue(outer_sub_id)
        self.assertNotEqual(inner_sub_id, outer_sub_id)

        # Both produce their own terminal ok
        terminal_oks = [e for e in events if e.get("status") == "ok"]
        terminal_sub_ids = {e.get("subId") for e in terminal_oks}
        self.assertEqual(len(terminal_oks), 2)
        self.assertIn(inner_sub_id, terminal_sub_ids)
        self.assertIn(outer_sub_id, terminal_sub_ids)

    # ------------------------------------------------------------------
    # 8. Explicit .fail() records failed terminal; clean exit adds no second ok
    # ------------------------------------------------------------------
    def test_explicit_fail_records_single_failed_terminal(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            with sub_process("P") as sp:
                sp.phase("processing")
                sp.fail("manual reason")
            return {"ok": True}

        result = worker.process_task(task())
        self.assertEqual(result["status"], "completed")
        events = result["events"]

        terminal_failed = [e for e in events if e.get("status") == "failed"]
        self.assertEqual(len(terminal_failed), 1)
        terminal = terminal_failed[0]
        self.assertEqual(terminal.get("message"), "manual reason")
        self.assertIn("durationMs", terminal["data"])

        # The clean __exit__ must NOT add a second ok terminal
        terminal_ok = [e for e in events if e.get("status") == "ok"]
        self.assertEqual(len(terminal_ok), 0)

    # ------------------------------------------------------------------
    # 9. Caller-supplied durationMs is preserved through the context manager
    # ------------------------------------------------------------------
    def test_caller_supplied_duration_ms_preserved(self):
        worker = Worker()

        @worker.step("payments.charge-card")
        def charge(_data, ctx: StepContext):
            with sub_process("P") as sp:
                sp.skip("x", data={"durationMs": 999})
            return {"ok": True}

        result = worker.process_task(task())
        events = result["events"]

        terminal_skipped = [e for e in events if e.get("status") == "skipped"]
        self.assertEqual(len(terminal_skipped), 1)
        self.assertEqual(terminal_skipped[0]["data"]["durationMs"], 999)


if __name__ == "__main__":
    unittest.main()
