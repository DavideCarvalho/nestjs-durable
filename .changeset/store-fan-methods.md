---
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-testing': minor
---

The TypeORM, Prisma and Drizzle stores (SQLite/libSQL and Postgres) implement `saveCheckpointIfPending` and `countCheckpoints`, like the MikroORM and in-memory stores already did.

- `saveCheckpointIfPending(checkpoint)` is one conditional `UPDATE … WHERE run_id = ? AND seq = ? AND status = 'pending'` that resolves whether a row changed. It never creates a missing row. The engine no longer falls back to a blind `saveCheckpoint` on these stores, so a turn stamping a redispatch deadline can't put a `completed` step back to `pending`.
- `countCheckpoints(runId, fromSeq, toSeq, statuses)` is one `COUNT(*)` over the `(run_id, seq)` key, so a step fan's join barrier no longer loads the whole run on every result.

The shared `runStateStoreContract` now expects both methods to exist, as it already does for the other optional methods every bundled store has. It also checks more cases: both seq bounds are inclusive, the count is scoped to its run, a refused write leaves the row unchanged, and the settling write clears the pending row's `wakeAt`. A custom store that leaves out either method now fails those two cases.
