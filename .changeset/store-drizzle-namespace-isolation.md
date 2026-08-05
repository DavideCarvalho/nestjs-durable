---
'@dudousxd/nestjs-durable-store-drizzle': minor
---

Enforce the `namespace` tenant boundary in the Drizzle adapter.

`StateStore` promises that "a worker only picks up / recovers / resumes-timers-for / times-out runs in
its own namespace". This adapter did not mention `namespace` anywhere: no column, and
`listIncompleteRuns()` / `listPendingRuns(limit)` / `listDueTimers(nowMs)` declared without the
parameter at all — legal TypeScript, since an implementation may take fewer arguments than its
interface, so nothing failed to compile. All four paths were unscoped, and the consequence was not a
missing dashboard filter: a worker serving tenant A picked up, recovered, resumed and cancelled tenant
B's runs, in silence.

Now scoped, every one of them:

- **picks up** — `listPendingRuns(limit, namespace)`; the foreign runs no longer eat the FIFO budget.
- **recovers** — `listIncompleteRuns(namespace)`.
- **resumes timers for** — `listDueTimers(nowMs, namespace)`.
- **times out** — `listRuns({ namespace })`, the query `engine.sweepTimeouts` issues.

A run also round-trips its namespace now, which re-arms the engine's own guards that were dead against
this store: the per-run namespace check on resume, and the blocked-run re-drive, both of which read
`run.namespace` and treat `undefined` as "belongs to everyone".

`undefined` means **no restriction** — the operator / control-plane view across all tenants — never
`namespace IS NULL`. An adapter that filtered on NULL there would look correct in a single-tenant test
and hide every run in production.

**Migration — and this adapter is the awkward one.** There is no auto-schema here; you own the
migration, and skipping it breaks *every* run query rather than just namespace filtering, because
drizzle SELECTs every column the schema declares. Exactly the trap `origin` and `priority` set:

```sql
ALTER TABLE durable_workflow_runs ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS durable_workflow_runs_namespace_status_idx
  ON durable_workflow_runs (namespace, status, created_at);
```

The `DEFAULT` is the load-bearing part: SQLite applies it to every existing row as part of the
`ADD COLUMN`, so pre-existing runs land in `'default'`. That is a fact about them, not a guess — they
really did execute in the unscoped namespace — and it is the only value that keeps them reachable,
since a default-namespace worker asking for `'default'` would silently skip a row left NULL and the run
would sit pending forever. This is the deliberate divergence from `origin`, which stays nullable with
no default because an origin genuinely cannot be reconstructed after the fact. If you run the bare
`ADD COLUMN namespace TEXT` anyway, the store reads NULL as `'default'` on both the predicate and the
mapper so those runs are not orphaned — but the statement above is the one to run.

**Index.** Unlike `origin`, `namespace` sits on every poll tick's predicate, so the schema declares
`durable_workflow_runs_namespace_status_idx (namespace, status, created_at)`, mirroring the MikroORM
adapter's index so a store swap keeps the same plan. Declaring it reaches only a database built or
migrated from this schema afterwards — an already-deployed one gets nothing until it runs the
`CREATE INDEX` above, which is why it is spelled out here.
