---
'@dudousxd/nestjs-durable-store-typeorm': minor
---

Enforce the `namespace` isolation boundary in the TypeORM adapter.

The adapter had no `namespace` column, and its list methods were declared `listPendingRuns(limit)` /
`listIncompleteRuns()` / `listDueTimers(nowMs)` — TypeScript lets an implementation take fewer
parameters than its interface promises, so the argument the engine passes was silently dropped and it
all compiled. The result was not a missing dashboard facet: a worker serving one tenant picked up,
recovered, resumed timers for and timed out **every** tenant's runs.

All four paths the `WorkflowRun.namespace` docblock names are now scoped — `listPendingRuns`,
`listIncompleteRuns`, `listDueTimers`, and `listRuns` (`RunQuery.namespace`), which is how the
engine's execution-timeout sweep finds its in-flight runs. `undefined` means **no restriction**, not
`namespace IS NULL`: that is the operator / control-plane view that sees every tenant, matching the
MikroORM adapter's global filter, so the two adapters cannot disagree about what a namespace is.

The column is `NOT NULL DEFAULT 'default'`, the opposite of `origin`. A run written before the column
existed really did execute in the unscoped namespace, so `'default'` states a fact; leaving those rows
NULL would make them match no equality predicate and so be invisible to every worker, forever.

Deployments: `ensureTypeOrmDurableSchema` adds the column through its `additive` map — the path
`events`, `enqueuedAt` and `origin` took — and the DDL default back-fills existing rows in the same
statement (Postgres 11+ and SQLite without a rewrite; MySQL 8.0.12+ instantly, older MySQL rewrites
the table once, so a very large `durable_workflow_runs` there wants a maintenance window). Nothing
else to do if auto-schema is on; if it is off, the same function called from your migration does it.

It also gains an index, `durable_runs_namespace_status_idx` on `(namespace, status, created_at)` —
unlike `origin`, this column is in every poll tick's predicate, and without it each tick scans every
other tenant's rows. Index creation is best-effort on every boot, so a database that already exists
picks it up as soon as it runs this version.
