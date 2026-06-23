---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable": minor
---

Add terminal-run retention pruning and the missing MikroORM store indexes, so the timer poller's per-tick scans stay cheap as run history grows.

**Retention.** New `retention` option on `DurableModule.forRoot`, driven by a worker-only `RetentionPoller` on its own interval (default 60s, separate from the 1s timer poll). Configure one or more policies per (disjoint) terminal-status group, each bounded by `maxAgeMs` and/or `maxCount` — composed most-restrictively (a run is pruned if it violates either bound), ranked by `updatedAt`:

```ts
retention: {
  sweepIntervalMs: 60_000,
  batchSize: 1_000,
  policies: [
    { statuses: ['completed', 'cancelled'], maxAgeMs: 14 * 24 * 3600_000, maxCount: 200 },
    { statuses: ['failed'], maxAgeMs: 90 * 24 * 3600_000 }, // keep failures longer
  ],
}
```

Backed by a new optional `StateStore.pruneTerminalRuns(policy, nowMs, limit)` capability (implemented by the MikroORM adapter; it cascades to child rows like `deleteRun` and self-drains in batches). Config is validated at boot: statuses must be terminal and disjoint, and each policy must set at least one bound. Core also exports `RetentionPolicy` and `TERMINAL_RUN_STATUSES`. Omitting `retention` keeps all history (unchanged default).

**Indexes.** The MikroORM store now defines the indexes the Prisma adapter already had — `durable_workflow_runs (status, wakeAt)` and `(workflow, status)`, plus `durable_run_attributes (key, numValue)` / `(key, strValue)` — so the poller's status/timer scans and the search-attribute EXISTS join are index-backed instead of full scans on an ever-growing table. `ensureMikroOrmDurableSchema` now also applies standalone `create index ... on durable_*` statements (the Postgres/SQLite index form), which were previously filtered out.
