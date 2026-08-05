---
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-prisma': minor
---

Persist and filter on a run's `origin`.

Every adapter stores `WorkflowRun.origin` and honours `RunQuery.origin`. The column is nullable with
**no default**, which is a deliberate divergence from how each adapter treats `namespace`: an old run
really did execute in some namespace, so backfilling it to `'default'` states a fact. Which package
declared its workflow cannot be reconstructed after the event, so the column stays NULL and reads back
as `undefined` — unknown. Never `'app'`, never `'unknown'`.

Filtering is plain equality, and a run with no origin therefore matches **no** origin value. It is not
folded into a bucket to make a facet look complete: unknown runs are reachable only with the filter
off, so any UI over this has to keep "all origins" as its default view. This matches the in-memory
reference store, so no adapter disagrees with the interface.

What each deployment has to do differs, because the adapters differ:

- **mikro-orm** — the entity fingerprint covers columns, so the boot heal emits the `ALTER TABLE`.
- **typeorm** — added to the `additive` map, so `ensureTypeOrmDurableSchema` adds it to a table that
  already exists, the same path `events` and `enqueuedAt` took.
- **drizzle** — no auto-schema here; the consumer owns the migration. Until
  `ALTER TABLE durable_workflow_runs ADD COLUMN origin TEXT;` runs, *every* run query fails, because
  drizzle selects all declared columns. Same trap `priority` set.
- **prisma** — the nullable model field emits the ADD COLUMN through Migrate; existing rows land NULL.

No index. `namespace` is indexed because every poll tick filters on it; `origin` is touched only by the
dashboard's listing, ANDed with `status` and `workflow`, which are indexed already. A deployment that
makes origin-filtered listings hot should add the composite index in its own migration — one added
here would never reach a database that has already booted.
