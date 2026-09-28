---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
---

Retention can be **scoped**, and a tenant's runs can be **purged** through the engine — no more
reaching into the `durable_*` tables to do either.

- **`RetentionPolicy.scope`** confines a policy to the runs matching a `RunScope` — `namespace(s)`,
  `workflow(s)`, `tag`/`tags`, search-attribute `attributes`. A scoped policy only selects, and for
  `maxCount` only counts, runs in its scope ("keep acme's newest 100"). Boot validation now requires
  status sets to be disjoint *per scope*, so a scoped policy can sit next to an unscoped default.
- **`engine.purgeRuns(scope, opts?)` / `engine.purgeNamespace(ns)`** hard-delete every run matching a
  scope, with their child subtrees (children inherit `namespace`, not `tags` — they go with their root
  either way), in bounded batches. Live runs are cancelled first (`cancelLive: false` keeps them). An
  empty scope is rejected.
- **`StateStore.deleteRuns(ids)`** (optional): bulk cascading delete, one `IN (...)` per table. The
  engine falls back to per-run `deleteRun` on a store without it.
- **`pruneTerminalRuns` everywhere.** The in-memory, Drizzle (SQLite), TypeORM and Prisma adapters now
  implement it (MikroORM and Drizzle Postgres already did, and now honor `scope`), so `retention` works
  on every bundled store. `CodecStateStore` now forwards `pruneTerminalRuns` and `deleteRuns` —
  retention used to be silently disabled behind the codec wrapper.
- The shared StateStore contract covers `deleteRuns`, age/count/scoped pruning and `engine.purgeRuns`.
