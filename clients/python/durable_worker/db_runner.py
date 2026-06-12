"""Run a :class:`Worker` against the SQL (DBOS-style) transport.

Instead of a broker, remote steps are **rows** in the same database the engine's durable store uses.
This runner claims task rows with ``SELECT … FOR UPDATE SKIP LOCKED`` (so workers never double-claim),
runs the handler, writes a result row the engine polls, and deletes the task — the exact contract the
TypeScript ``DbTransport`` implements, so the two interoperate on the same tables.

Supports **Postgres** (``pip install durable-worker[postgres]``) and **MySQL 8+**
(``pip install durable-worker[mysql]``). SQLite is unsupported — it has no ``SKIP LOCKED``.

See the table + claim-protocol contract in the docs; both libraries implement against that one spec.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, Dict, List, Optional

from .worker import Worker

TASK_COLS = ["step_id", "run_id", "seq", "name", "grp", "input", "attempt", "status", "created_at"]
RESULT_COLS = ["step_id", "run_id", "seq", "status", "output", "error", "started_at", "created_at"]


class _Dialect:
    """The two SQL bits that differ between Postgres and MySQL — everything else is shared."""

    def __init__(self, kind: str) -> None:
        if kind not in ("postgres", "mysql"):
            raise ValueError(f"dialect must be 'postgres' or 'mysql', got {kind!r}")
        self.kind = kind

    def ph(self, i: int) -> str:
        """Positional placeholder for param ``i`` (1-based): ``$i`` on Postgres, ``%s`` on MySQL."""
        return f"${i}" if self.kind == "postgres" else "%s"

    def q(self, ident: str) -> str:
        return f'"{ident}"' if self.kind == "postgres" else f"`{ident}`"

    @property
    def text(self) -> str:
        return "text" if self.kind == "postgres" else "longtext"

    def insert_ignore(self, table: str, cols: List[str]) -> str:
        names = ", ".join(self.q(c) for c in cols)
        values = ", ".join(self.ph(i + 1) for i in range(len(cols)))
        if self.kind == "postgres":
            return (
                f"INSERT INTO {table} ({names}) VALUES ({values}) "
                f"ON CONFLICT ({self.q('step_id')}) DO NOTHING"
            )
        return f"INSERT IGNORE INTO {table} ({names}) VALUES ({values})"


class _Contract:
    """Builds the contract SQL (pure, no driver) for a given prefix + dialect — unit-testable."""

    def __init__(self, prefix: str, dialect: _Dialect, batch_size: int) -> None:
        self.d = dialect
        self.batch_size = batch_size
        self.tasks = dialect.q(f"{prefix}_transport_tasks")
        self.results = dialect.q(f"{prefix}_transport_results")

    def create_tables(self) -> List[str]:
        q, txt = self.d.q, self.d.text
        return [
            f"""CREATE TABLE IF NOT EXISTS {self.tasks} (
                {q('step_id')} varchar(191) PRIMARY KEY,
                {q('run_id')} varchar(191) NOT NULL,
                {q('seq')} integer NOT NULL,
                {q('name')} varchar(191) NOT NULL,
                {q('grp')} varchar(191) NOT NULL,
                {q('input')} {txt},
                {q('attempt')} integer NOT NULL,
                {q('status')} varchar(32) NOT NULL,
                {q('claimed_by')} varchar(191),
                {q('claimed_at')} bigint,
                {q('created_at')} bigint NOT NULL
            )""",
            f"""CREATE TABLE IF NOT EXISTS {self.results} (
                {q('step_id')} varchar(191) PRIMARY KEY,
                {q('run_id')} varchar(191) NOT NULL,
                {q('seq')} integer NOT NULL,
                {q('status')} varchar(32) NOT NULL,
                {q('output')} {txt},
                {q('error')} {txt},
                {q('started_at')} bigint,
                {q('claimed_by')} varchar(191),
                {q('claimed_at')} bigint,
                {q('created_at')} bigint NOT NULL
            )""",
        ]

    def select_claim(self) -> str:
        """Lease-aware claim select. Params: ``[group, stale_before]``."""
        q = self.d.q
        lease = f"({q('claimed_at')} IS NULL OR {q('claimed_at')} < {self.d.ph(2)})"
        return (
            f"SELECT * FROM {self.tasks} WHERE {q('grp')} = {self.d.ph(1)} AND {lease} "
            f"ORDER BY {q('created_at')} ASC LIMIT {self.batch_size} FOR UPDATE SKIP LOCKED"
        )

    def claim_update(self, n_ids: int) -> str:
        """Stamp the lease on the claimed rows. Params: ``[claimed_by, claimed_at, *step_ids]``."""
        q = self.d.q
        ids = ", ".join(self.d.ph(i + 3) for i in range(n_ids))
        return (
            f"UPDATE {self.tasks} SET {q('claimed_by')} = {self.d.ph(1)}, "
            f"{q('claimed_at')} = {self.d.ph(2)} WHERE {q('step_id')} IN ({ids})"
        )

    def insert_result(self) -> str:
        return self.d.insert_ignore(self.results, RESULT_COLS)

    def delete_task(self) -> str:
        return f"DELETE FROM {self.tasks} WHERE {self.d.q('step_id')} = {self.d.ph(1)}"


def row_to_task(row: Dict[str, Any]) -> Dict[str, Any]:
    """Map a claimed task row to the ``RemoteTask`` envelope the worker expects."""
    raw_input = row.get("input")
    return {
        "runId": row["run_id"],
        "seq": int(row["seq"]),
        "stepId": row["step_id"],
        "name": row["name"],
        "group": row["grp"],
        "input": None if raw_input is None else json.loads(raw_input),
        "attempt": int(row["attempt"]),
    }


def result_to_params(result: Dict[str, Any], now_ms: int) -> List[Any]:
    """Map a ``StepResult`` to the result-insert params (column order = ``RESULT_COLS``)."""
    output = result.get("output")
    error = result.get("error")
    return [
        result["stepId"],
        result["runId"],
        result["seq"],
        result["status"],
        None if output is None else json.dumps(output),
        None if error is None else json.dumps(error),
        result.get("startedAt"),
        now_ms,
    ]


def _now_ms() -> int:
    return int(time.time() * 1000)


class _Backend:
    """Driver-specific execution behind the shared claim/complete algorithm."""

    async def ensure_schema(self) -> None: ...
    async def claim(self, group: str, stale_before: int, instance_id: str) -> List[Dict[str, Any]]: ...
    async def complete(self, params: List[Any], step_id: str) -> None: ...
    async def close(self) -> None: ...


class _PostgresBackend(_Backend):
    def __init__(self, pool: Any, contract: _Contract) -> None:
        self.pool, self.c = pool, contract

    async def ensure_schema(self) -> None:
        async with self.pool.acquire() as conn:
            for ddl in self.c.create_tables():
                await conn.execute(ddl)

    async def claim(self, group: str, stale_before: int, instance_id: str) -> List[Dict[str, Any]]:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                rows = [dict(r) for r in await conn.fetch(self.c.select_claim(), group, stale_before)]
                if rows:
                    ids = [r["step_id"] for r in rows]
                    await conn.execute(self.c.claim_update(len(ids)), instance_id, _now_ms(), *ids)
                return rows

    async def complete(self, params: List[Any], step_id: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(self.c.insert_result(), *params)
            await conn.execute(self.c.delete_task(), step_id)

    async def close(self) -> None:
        await self.pool.close()


class _MysqlBackend(_Backend):
    def __init__(self, pool: Any, contract: _Contract) -> None:
        self.pool, self.c = pool, contract

    async def ensure_schema(self) -> None:
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                for ddl in self.c.create_tables():
                    await cur.execute(ddl)
            await conn.commit()

    async def claim(self, group: str, stale_before: int, instance_id: str) -> List[Dict[str, Any]]:
        import aiomysql

        async with self.pool.acquire() as conn:
            await conn.begin()
            async with conn.cursor(aiomysql.DictCursor) as cur:
                await cur.execute(self.c.select_claim(), (group, stale_before))
                rows = list(await cur.fetchall())
                if rows:
                    ids = [r["step_id"] for r in rows]
                    await cur.execute(self.c.claim_update(len(ids)), (instance_id, _now_ms(), *ids))
            await conn.commit()
            return rows

    async def complete(self, params: List[Any], step_id: str) -> None:
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(self.c.insert_result(), tuple(params))
                await cur.execute(self.c.delete_task(), (step_id,))
            await conn.commit()

    async def close(self) -> None:
        self.pool.close()
        await self.pool.wait_closed()


async def _make_backend(dialect: str, dsn: str, contract: _Contract) -> _Backend:
    if dialect == "postgres":
        import asyncpg  # imported lazily so the SDK works without the driver

        return _PostgresBackend(await asyncpg.create_pool(dsn), contract)
    import aiomysql

    # dsn form: mysql://user:pass@host:port/db
    from urllib.parse import urlparse

    u = urlparse(dsn)
    pool = await aiomysql.create_pool(
        host=u.hostname or "localhost",
        port=u.port or 3306,
        user=u.username,
        password=u.password,
        db=(u.path or "/").lstrip("/") or None,
        autocommit=False,
    )
    return _MysqlBackend(pool, contract)


async def run_db_worker(
    worker: Worker,
    *,
    group: str,
    dsn: str,
    dialect: str,
    prefix: str = "durable",
    poll_ms: int = 500,
    lease_ms: int = 30_000,
    batch_size: int = 10,
    auto_create: bool = True,
    instance_id: Optional[str] = None,
    stop: Optional[asyncio.Event] = None,
    backend: Optional[_Backend] = None,
) -> None:
    """Poll the SQL transport for ``group`` and run handlers until ``stop`` is set.

    ``dialect`` is ``"postgres"`` or ``"mysql"``; ``dsn`` is the connection string. Pass ``backend``
    to inject a preconfigured one (for tests). The tables must match the engine's ``DbTransport``
    ``prefix`` — they share the rows.
    """

    contract = _Contract(prefix, _Dialect(dialect), batch_size)
    backend = backend or await _make_backend(dialect, dsn, contract)
    instance_id = instance_id or f"py-{uuid.uuid4().hex[:8]}"
    stop = stop or asyncio.Event()

    if auto_create:
        await backend.ensure_schema()

    try:
        while not stop.is_set():
            rows = await backend.claim(group, _now_ms() - lease_ms, instance_id)
            for row in rows:
                task = row_to_task(row)
                result = await worker.aprocess_task(task)
                await backend.complete(result_to_params(result, _now_ms()), task["stepId"])
            if not rows:
                await asyncio.sleep(poll_ms / 1000)
    finally:
        await backend.close()
