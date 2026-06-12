import asyncio
import json
import unittest

from durable_worker import Worker
from durable_worker.db_runner import (
    _Backend,
    _Contract,
    _Dialect,
    result_to_params,
    row_to_task,
    run_db_worker,
)


def a_row(**over):
    base = {
        "step_id": "r1:0", "run_id": "r1", "seq": 0, "name": "payments.charge-card",
        "grp": "payments", "input": json.dumps({"orderId": "o1"}), "attempt": 1,
    }
    base.update(over)
    return base


class DialectTest(unittest.TestCase):
    def test_postgres_placeholders_and_quoting(self):
        d = _Dialect("postgres")
        self.assertEqual(d.ph(1), "$1")
        self.assertEqual(d.q("grp"), '"grp"')
        self.assertEqual(d.text, "text")

    def test_mysql_placeholders_and_quoting(self):
        d = _Dialect("mysql")
        self.assertEqual(d.ph(1), "%s")
        self.assertEqual(d.q("grp"), "`grp`")
        self.assertEqual(d.text, "longtext")

    def test_rejects_unknown_dialect(self):
        with self.assertRaises(ValueError):
            _Dialect("sqlite")


class ContractSqlTest(unittest.TestCase):
    def test_claim_select_uses_skip_locked_and_the_group_filter(self):
        c = _Contract("durable", _Dialect("postgres"), batch_size=10)
        sql = c.select_claim()
        self.assertIn('"durable_transport_tasks"', sql)
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)
        self.assertIn('"grp" = $1', sql)
        self.assertIn("LIMIT 10", sql)

    def test_insert_result_is_idempotent_per_dialect(self):
        pg = _Contract("durable", _Dialect("postgres"), 10).insert_result()
        self.assertIn("ON CONFLICT", pg)
        self.assertIn('"started_at"', pg)
        my = _Contract("durable", _Dialect("mysql"), 10).insert_result()
        self.assertIn("INSERT IGNORE", my)
        self.assertIn("`started_at`", my)

    def test_claim_update_placeholders_offset_past_lease_params(self):
        c = _Contract("durable", _Dialect("postgres"), 10)
        # claimed_by=$1, claimed_at=$2, then the ids start at $3
        self.assertIn("IN ($3, $4)", c.claim_update(2))


class MappingTest(unittest.TestCase):
    def test_row_to_task_parses_json_input(self):
        task = row_to_task(a_row())
        self.assertEqual(task["stepId"], "r1:0")
        self.assertEqual(task["input"], {"orderId": "o1"})
        self.assertEqual(task["group"], "payments")

    def test_result_to_params_keeps_started_at_for_queue_wait(self):
        params = result_to_params(
            {"stepId": "r1:0", "runId": "r1", "seq": 0, "status": "completed",
             "output": {"ok": 1}, "startedAt": 123}, now_ms=999
        )
        # column order: step_id, run_id, seq, status, output, error, started_at, created_at
        self.assertEqual(params[0], "r1:0")
        self.assertEqual(json.loads(params[4]), {"ok": 1})
        self.assertIsNone(params[5])
        self.assertEqual(params[6], 123)
        self.assertEqual(params[7], 999)


class FakeBackend(_Backend):
    def __init__(self, rows, stop):
        self._rows, self._stop = rows, stop
        self.completed = []
        self.schema_ready = False

    async def ensure_schema(self):
        self.schema_ready = True

    async def claim(self, group, stale_before, instance_id):
        batch, self._rows = self._rows, []
        if not batch:
            self._stop.set()
        return batch

    async def complete(self, params, step_id):
        self.completed.append((step_id, params))

    async def close(self):
        pass


class RunLoopTest(unittest.TestCase):
    def test_claims_runs_and_completes_a_task(self):
        worker = Worker(group="payments")

        @worker.step("payments.charge-card")
        async def charge(data):
            return {"chargeId": f"ch_{data['orderId']}"}

        async def go():
            stop = asyncio.Event()
            backend = FakeBackend([a_row()], stop)
            await run_db_worker(worker, group="payments", dsn="", dialect="postgres",
                                stop=stop, backend=backend, poll_ms=1)
            return backend

        backend = asyncio.run(go())
        self.assertTrue(backend.schema_ready)
        self.assertEqual(len(backend.completed), 1)
        step_id, params = backend.completed[0]
        self.assertEqual(step_id, "r1:0")
        self.assertEqual(params[3], "completed")  # status column
        self.assertEqual(json.loads(params[4]), {"chargeId": "ch_o1"})  # output column


if __name__ == "__main__":
    unittest.main()
