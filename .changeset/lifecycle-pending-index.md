---
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
---

Postgres: the owed-lifecycle listing (`tags LIKE '%"durable:lifecycle:pending"%'`, settled runs, newest first) reads a new partial index, `durable_runs_lifecycle_pending_idx` on `created_at`, instead of scanning the whole runs table. The schema helper builds it with `CREATE INDEX CONCURRENTLY` (plainly inside a transaction block), rebuilds an invalid leftover, and retries on the next boot when the build fails; MikroORM bumps its schema revision so an existing database gets it on the next boot, and records the fingerprint only once the index is valid. The listing now sends that tag as a literal so every plan can use the index. MySQL and SQLite are unchanged.
