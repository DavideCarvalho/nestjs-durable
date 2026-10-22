---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
---

Periodic recovery only touches orphaned runs. `recoverIncomplete` runs on every timer tick on every worker, and it listed every `running`/`cancelling` run and issued a lock-attempt UPDATE for each one, including every healthy run whose lease a live turn was renewing. It now asks the store for orphans only, through the new optional `StateStore.listOrphanedRuns(nowMs, limit, namespace?)`: incomplete runs whose lease is free or expired, oldest first, at most 500 per pass. On a healthy fleet that is about zero rows per tick. Every bundled store implements it as one indexed query, `CodecStateStore` forwards it, and the shared `runStateStoreContract` gains a case for it. A store without it still works: the engine lists the incomplete runs as before and skips the leased ones in memory, which still spares the per-run lock attempts.

With more than 500 orphans at once (a whole fleet restarting with many runs in flight), one pass reclaims 500 and the next tick takes the rest. If you drive `engine.recoverIncomplete()` yourself instead of through the timer poller, call it on an interval, not only once at boot.
