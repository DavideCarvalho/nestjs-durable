---
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-transport-bullmq": patch
"@dudousxd/nestjs-durable-testing": patch
---

MySQL timestamps keep their milliseconds. The MikroORM and TypeORM stores created every timestamp column as a bare `datetime`, which holds whole seconds and rounds the milliseconds away: lease expiry, `wakeAt` and buffered-event order moved by up to half a second, so a timer could fire early and an engine could reclaim a lease it took just after booting as if a previous process held it. Columns are now `datetime(6)` (Postgres `timestamptz` was already microsecond, and is unchanged).

An existing MySQL deployment is upgraded by the boot-time schema heal. MySQL runs that type change as a table copy that blocks writes, so on an existing table with more than `blockingAlterRowLimit` rows (default 100000; `schemaBlockingAlterRowLimit` on the store) the statement is logged for you to run out of band instead of run at boot, and the warning repeats each boot until the column matches.

The BullMQ transport now rewrites every routing token's descriptor copy when a later `handle()` adds a step. A reader keeps whichever copy its SCAN meets first, so a stale copy left the new step's heartbeat undeclared, and the workflow directory listed that step's queue as a callable workflow until the next heartbeat interval.

The StateStore contract fails instead of passing silently when its backend is unavailable and `DURABLE_TEST_REQUIRE_BACKENDS` is set.

The run-dispatch contract's "leaves a run whose queueing failed pending" case waits for both re-queued runs to complete, since a consumer may take them in either order. Its "splits a fan's children across the instances" case holds each child until both instances have started one, so the split no longer depends on which in-process consumer the scheduler favours.

The MikroORM store changes all of a table's timestamp columns in one `ALTER` (its schema diff emits one per column, and MySQL copies the table for each), and both stores log a deferred change as one copy-pasteable statement per table, one per line.
