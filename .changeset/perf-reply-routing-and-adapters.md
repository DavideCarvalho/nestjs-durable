---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-testing': patch
---

Step results go back to the engine holding the parked body, and the TypeORM, MikroORM and Prisma stores save the same round trips as the Drizzle one.

- **Routed replies**: a dispatched `ctx.step` task carries `replyTo` (the dispatching engine instance), and a transport that implements the new optional `Transport.consumeRepliesFor` sends its result back there, so with several engines the sticky continuation keeps hitting instead of replaying elsewhere. Step fans keep the shared results. Engine / `DurableModule` option `routeReplies` (default `true` while the sticky cache is on).
- **BullMQ** implements it: an engine consumes `<prefix>-results-to-<instance>` and keeps an alive key in Redis; workers send a result there (batched) only while the key exists, else to the shared queue, and every transport moves a dead instance's queue (stalled jobs included) to the shared results, so no result is lost. Options `replyRouting` (default `true`), `replyAliveTtlMs`, `replySweepMs`, `replyDrainIdleMs`. Older engines and workers ignore the field.
- **TypeORM, MikroORM, Prisma** implement `settleResultsIfPending`, `tryLockRunAndGet` (Postgres), `insertCheckpointIfAbsent` and `claimPendingRuns` on Postgres and MySQL; Prisma also sends the suspend, the lease release and the first-dispatch insert as single statements instead of `updateMany`/`createMany`'s implicit transactions. New core helper `settleResultsWithPlainCalls` for stores without `RETURNING`.
- **Testing**: the state-store contract pins `updatedAt` to the millisecond, and lets concurrent `claimPendingRuns` leave rows for a later claim (never the same row twice).
