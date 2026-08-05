---
'@dudousxd/nestjs-durable-store-prisma': minor
---

Enforce the `namespace` tenant boundary in the Prisma store.

The adapter never mentioned `namespace`. There was no column, and its list methods were declared as
`listPendingRuns(limit)` / `listIncompleteRuns()` / `listDueTimers(nowMs)` — TypeScript lets an
implementation take fewer parameters than the interface promises, so the argument the engine passes
was silently dropped at the call boundary and nothing failed to compile. The result was not a missing
dashboard filter: a worker serving tenant A picked up, recovered, resumed timers for and timed out
tenant B's runs. The last of those is a write — `sweepTimeouts` selects its cancellation candidates
through `listRuns({ workflow, status, namespace })`, and that predicate was unfiltered too, so a
cross-tenant sweep cancelled other tenants' runs outright.

All four paths are now scoped, matching the MikroORM adapter's semantics:

- `listPendingRuns` (pick up), `listIncompleteRuns` (recover), `listDueTimers` (resume timers) —
  plain equality on the new column.
- `listRuns` honours `RunQuery.namespace` (the timeout sweep, and the dashboard's tenant filter).

`undefined` means **no restriction**, not "namespace IS NULL". That is the operator/control-plane view
that sees every tenant, and it is what an engine running unscoped passes; reading it as `IS NULL`
would look right in a single-tenant test and hide every run in production. Point reads (`getRun`,
checkpoints) stay unscoped, as the `StateStore` interface specifies.

The column is `String @default("default")` — **NOT NULL with a default**, the deliberate opposite of
`origin`. A run written before the column existed was executed by an engine with no namespace, and
such an engine both stamps and polls as `'default'`, so `'default'` is that row's true namespace
rather than a stand-in. Leaving old rows NULL is the option that breaks: a `'default'` worker's
`WHERE namespace = 'default'` never matches a NULL row, and the run would never be picked up again.
For the same reason the adapter does **not** coerce a NULL read back to `'default'` — that would show
a healthy namespace in the dashboard for a run no worker can see.

Existing deployments get exactly this from Prisma Migrate, verified with `prisma migrate diff`:

```sql
ALTER TABLE "durable_workflow_runs" ADD COLUMN "namespace" TEXT NOT NULL DEFAULT 'default';
CREATE INDEX "durable_workflow_runs_namespace_status_idx"
  ON "durable_workflow_runs"("namespace", "status", "created_at");
```

The `ADD COLUMN` back-fills every existing row in one statement on Postgres/MySQL/SQLite alike. Until
it runs, the generated client no longer satisfies `DurablePrismaClient`, so the missing migration
shows up as a type error rather than as runs quietly leaking across tenants.

The index is not optional the way `origin`'s absent one is: `namespace` is on the predicate of every
poll tick, on all three list methods. It is named explicitly because Prisma would otherwise derive
`durable_workflow_runs_namespace_status_created_at_idx`, while MikroORM declares the same index as
`durable_workflow_runs_namespace_status_idx` — pinning the name keeps a store swap from dropping and
rebuilding it.
