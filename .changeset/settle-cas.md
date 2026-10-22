---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
---

A turn's outcome no longer overwrites a run that was cancelled, completed or dead-lettered while the turn ran. A turn settles from a snapshot read before the body ran, and `settleRun` wrote `completed` and `failed` unconditionally (only the `suspended` write re-read the run first, and only looked for `cancelled`). So a plain `cancel()` landing while a step body was still executing was overwritten when the body finished: the run ended `completed` (or `failed`), `run.completed` was emitted and the parent was notified, for a run the operator had cancelled.

Settling is now a compare-and-set on the run's status through the new optional `StateStore.updateRunIf(runId, expectedStatuses, patch)`, which applies the patch only while the status is one of `expectedStatuses` and resolves whether it wrote. Completed and failed outcomes write over any status except `cancelled`, `completed` and `dead`; a suspend or `blocked` park also leaves a `cancelling` run alone, so a compensating cancel requested mid-turn is finished by its compensation turn instead of parking as `suspended`. A settle that loses the race reports the run's current state and emits nothing.

Every bundled store implements `updateRunIf` as one conditional `UPDATE … WHERE id = ? AND status IN (…)`: TypeORM, MikroORM, Prisma, Drizzle (SQLite/MySQL and Postgres) and the in-memory store. `CodecStateStore` forwards it, encoding the patch like `updateRun`. A custom store without it still works: the engine re-reads the run and then writes, which narrows the race but cannot close it. The shared `runStateStoreContract` gains `updateRunIf` cases that expect the method, so a custom store running the contract fails them until it adds it.
