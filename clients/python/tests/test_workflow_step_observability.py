"""WorkflowContext.step observability: live lifecycle, real timing, and captured sub-processes.

A Python @workflow runs its ctx.steps inline; each step must stream running → completed (so it shows
up live, not all at turn-end), record a real wall-clock window (not 0ms), and capture the
sub_process/log trail a handler emits (so each handler's p-processes show under it).
"""

import unittest

from durable_worker import WorkflowWorker, log, sub_event


class WorkflowStepObservabilityTest(unittest.TestCase):
    def _run(self):
        worker = WorkflowWorker(group="g", auto_register=False)

        @worker.workflow("wf")
        def wf(ctx, _data):
            def handler():
                sub_event(id="p1", name="proc-1", status="ok")
                log("info", "did a thing")
                return {"ok": True}

            return ctx.step("handle_x", handler)

        events = []
        decision = worker.process_task(
            {"taskId": "t", "runId": "r1", "workflow": "wf", "history": [], "input": {}},
            on_step=events.append,
        )
        return events, decision

    def test_streams_running_then_completed(self):
        events, _ = self._run()
        self.assertEqual([e["phase"] for e in events], ["running", "completed"])
        running, completed = events
        self.assertEqual((running["seq"], running["name"]), (0, "handle_x"))
        self.assertIn("startedAt", running)
        self.assertEqual(completed["output"], {"ok": True})

    def test_records_a_real_duration(self):
        events, decision = self._run()
        completed = events[1]
        self.assertLessEqual(completed["startedAt"], completed["finishedAt"])
        cmd = decision["commands"][0]
        self.assertEqual(cmd["kind"], "recordStep")
        self.assertIn("startedAt", cmd)
        self.assertIn("finishedAt", cmd)

    def test_captures_subprocess_events_under_the_step(self):
        events, decision = self._run()
        completed_events = events[1]["events"]
        self.assertTrue(
            any(e.get("name") == "proc-1" and e.get("status") == "ok" for e in completed_events)
        )
        # The same trail rides the recordStep command (so it persists, not just streams).
        cmd_events = decision["commands"][0]["events"]
        self.assertTrue(any(e.get("name") == "proc-1" for e in cmd_events))


if __name__ == "__main__":
    unittest.main()
