---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-testing': patch
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

A step result is no longer overwritten back to `pending`. A turn that stamps a pending step's redispatch deadline (or re-dispatches it) wrote the row it had read a moment earlier. If the worker's result landed in between, the step went back to `pending` with no result, the run parked until the deadline, and the step ran a second time.

- `StateStore.saveCheckpointIfPending` (optional, new) writes only while the stored row is still `pending` and reports whether it wrote. The engine uses it for the redispatch stamp, the redispatch itself, and for settling a step from its result, which also drops a duplicate delivery of the same result. A store without it falls back to `saveCheckpoint`. The MikroORM and in-memory stores implement it, and the shared store contract covers it.
- BullMQ result jobs are retried (5 attempts, exponential backoff) when the engine's handler throws, failed ones are kept for 24h instead of deleted, and a result given up on is logged. Before, one store error at peak load dropped the result silently.
- Two starts of the same run id that race between `start`'s existence check and its insert now converge on the winner's run. Before, the loser threw on the primary key; for a `ctx.all`/`ctx.child` child that throw was reported to the parent as "child failed to start", so a child that ran and completed failed the parent's fan.
