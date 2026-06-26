---
"@dudousxd/nestjs-durable-store-prisma": patch
---

Make `releaseRunLock` idempotent. It now uses `updateMany` instead of `update`, so releasing the lease on a run that no longer exists is a no-op rather than throwing Prisma's P2025 (`No record was found for an update`). The engine calls `releaseRunLock` best-effort in a `finally` after a run settles, which can race a concurrent purge/teardown; the old `update({ where: { id } })` surfaced that race as an unhandled rejection. This now mirrors the in-memory store's `if (run)` guard and the set-where semantics of the TypeORM/MikroORM/Drizzle adapters.
