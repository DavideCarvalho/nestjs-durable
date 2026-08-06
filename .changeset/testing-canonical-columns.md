---
'@dudousxd/nestjs-durable-testing': patch
---

Pin `awaitingDecisionTaskId` and `parallelGroup` in the cross-adapter column contract

`DURABLE_CANONICAL_COLUMNS` is the map that makes a store swap safe: every adapter must put the same
entity property in the same physical column, and each adapter's `column-naming.spec.ts` asserts its
own mapping against it. Two columns that all four adapters already declare were missing from it, so
they were the one part of the schema no adapter's spec could disagree about — because nothing said
what they should be.

- `durable_workflow_runs.awaiting_decision_task_id` — the REMOTE turn the engine suspended on.
  `completeRemoteDecision` matches against it so that only the currently-awaited turn's decision is
  applied. A store swap that spelled this column differently would not fail loudly; it would apply a
  stale decision to the wrong turn.
- `durable_step_checkpoints.parallel_group` and `durable_signal_waiters.parallel_group` — the group
  a `ctx.gather`/`ctx.all` fan tags its siblings with, so the dashboard renders them as one parallel
  group rather than N sequential singles. The same physical name in two tables, which is exactly the
  near-duplicate that drifts when nothing pins it.

Both satisfy the map's admission rule, which is why they belong here and `namespace` did not until
recently: every adapter declares them. Verified against MikroORM's `entities.ts`, TypeORM's
`entities.ts`, Drizzle's `schema.ts` and Prisma's `schema.prisma` before adding.

No runtime behaviour changes — this is the contract getting stricter about what it already required.
An adapter outside this repo whose naming diverges on these two will now see it as a failing spec
instead of an "Unknown column" in production.
