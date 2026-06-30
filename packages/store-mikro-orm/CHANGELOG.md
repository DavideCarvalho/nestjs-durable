# @dudousxd/nestjs-durable-store-mikro-orm

## 0.17.0

### Minor Changes

- 2e5867f: Gate `ensureMikroOrmDurableSchema` behind a schema fingerprint so steady-state boots skip the expensive work. Previously every boot of every pod ran `getUpdateSchemaSQL({ safe: true })` — which introspects the WHOLE database's `information_schema` because the store shares the app ORM — plus 5 keyed `information_schema.tables` collation probes, even when nothing had changed.

  A new `durable_schema_meta` marker table records the fingerprint of the durable schema last applied. Each boot computes the expected fingerprint purely in-memory from the entity metadata (canonical, sorted serialization of each owned table's columns + indexes, plus the configured `collate` and a hand-bumpable `SCHEMA_REVISION`) and compares it to the stored one. When they match, the gate returns after two cheap round-trips (a `CREATE TABLE IF NOT EXISTS` for the marker + one PK read), skipping both the introspection and the collation probes entirely.

  A fresh/empty DB (no marker) and CI still auto-create everything zero-config. The full heal re-runs only when the fingerprint is absent or stale — an entity/metadata change or a `SCHEMA_REVISION` bump — under a best-effort cross-pod advisory lock (MySQL `GET_LOCK` / Postgres `pg_advisory_lock`, skipped on SQLite) with a re-check after acquiring in case a sibling pod healed first. Caller-facing `autoSchema` behavior is unchanged.

## 0.16.2

### Patch Changes

- 3de762c: Fix: remote workflow-turn decisions are now applied durably and instance-agnostically, so a
  multi-instance deployment no longer hangs runs after a `gather_calls`/remote child completes.

  Previously `RemoteWorkflowExecutor` awaited each dispatched turn's decision via an in-memory,
  per-instance `pending` map. With multiple engine instances sharing the broker, the `decisions` queue
  is point-to-point: a decision was often consumed by an instance that did NOT dispatch the turn, which
  had no matching waiter → the decision was dropped → the run stayed `suspended` forever with all its
  steps `completed` (and recovery never re-drove suspended runs). Single-instance never hit it, so it
  surfaced only intermittently in multi-pod deployments.

  Now the engine dispatches the turn and SUSPENDS, recording `WorkflowRun.awaitingDecisionTaskId`. A new
  `completeRemoteDecision` (wired on every instance) applies the decision on whichever instance receives
  it — looked up by `decision.runId`, gated on the awaited `taskId` (stale/duplicate/foreign decisions
  ignored), durably — mirroring how remote step results already work. `RemoteWorkflowExecutor` is now a
  fire-and-forget dispatcher (no in-memory await). Liveness moved to recovery: a run awaiting a decision
  past its `remoteAdvanceSilenceMs` window is re-driven by the timer poller (heartbeat-rearmed), which
  also fixes stuck `suspended` runs never being recovered. The store adapters persist the new
  `awaitingDecisionTaskId` column (additive, nullable; mikro-orm/typeorm autoSchema add it on boot).

## 0.16.1

### Patch Changes

- 99e78fb: Remote `startChild` / `gather_children` child-await `signal:child:` checkpoints now carry the command's `parallelGroup`. The fan group is threaded `command → signal waiter → checkpoint`: the engine stamps each child waiter with the awaiting `startChild` command's group, and the resolving `signal:child:<id>` checkpoint (written when the child notifies the parent) inherits it. Each store adapter persists a nullable `parallel_group` column on the signal-waiter row so it round-trips `put → take`. As a result the dashboard renders a cross-SDK parallel child fan-out (e.g. a Python `ctx.gather_children`) stacked vertically as one parallel group instead of a misleading horizontal `start → s1 → … → sN → end` sequential chain. Additive and backward-compatible: existing waiter rows simply have a NULL group.

## 0.16.0

### Minor Changes

- 21d5594: Add `namespace` run partitioning. An engine configured with a `namespace` stamps it on every run it
  creates and only picks up / recovers / resumes-timers-for / times-out runs in that namespace. The
  StateStore list methods (`listPendingRuns`, `listIncompleteRuns`, `listDueTimers`) and `RunQuery`
  gain an optional namespace filter. Default `'default'` — byte-identical to a single-pool deployment.
  Implemented for the MikroORM store; Drizzle/TypeORM/Prisma parity is a follow-up (they ignore the
  filter until then). Read paths (dashboard, `getRun`) are intentionally not namespace-scoped.

## 0.15.1

### Patch Changes

- 10fdd09: Persist `parallelGroup` on step checkpoints. A `ctx.gather`/`ctx.all` fan tags every sibling step with the same group so the dashboard renders them as one "ran in parallel" group, and the core engine carries it (including from a remote/polyglot worker's `recordStep`). The MikroORM store, however, had no column for it, so `toCheckpointEntity` dropped it on insert and `fromCheckpointEntity` returned `undefined` — the fan always rendered as N sequential `single` rows. Adds a nullable `parallel_group` column (auto-added on boot by `ensureMikroOrmDurableSchema`, no manual migration) and maps it in both directions.

## 0.15.0

### Minor Changes

- c4b133f: Retention config now accepts `ms`-style duration strings (and no longer leaks raw millisecond magic numbers).

  `RetentionPolicy.maxAgeMs` → **`maxAge`** and `DurableRetentionOptions.sweepIntervalMs` → **`sweepInterval`**, each now `number | string`: a number is still milliseconds, a string is parsed by the library's existing `parseDuration` (the same parser behind `ctx.sleep` / `executionTimeout`), e.g. `'30d'`, `'2w'`, `'5m'`. Note `'m'` is **minutes** (the `ms` convention) — there is no month unit, so use `'30d'` / `'90d'` for a month / quarter. Unparseable strings throw at boot (fail fast).

  ```ts
  retention: {
    sweepInterval: '5m',
    policies: [
      { statuses: ['completed', 'cancelled'], maxAge: '30d', maxCount: 200 },
      { statuses: ['failed'], maxAge: '90d' },
    ],
  }
  ```

  This refines the retention API shipped in the previous minor (`maxAgeMs` / `sweepIntervalMs`); update those two field names if you adopted it.

## 0.14.0

### Minor Changes

- 00713f8: Add terminal-run retention pruning and the missing MikroORM store indexes, so the timer poller's per-tick scans stay cheap as run history grows.

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

## 0.13.3

### Patch Changes

- c1aaacd: Add a transient `cancelling` run status so a compensating cancel is visible (and durable) instead of looking like a still-`running` run.

  **core:** `RunStatus` gains a non-terminal `'cancelling'`. `cancel(runId, { compensate: true })` now persists `cancelling` immediately (and returns it) while the background saga undo runs, then flips to `cancelled` — previously the run stayed `running`/`suspended` with no outward signal that a cancel was in flight. A repeat compensating cancel is idempotent. The status is treated as in-flight everywhere it must be: the singleton admission gate counts it, and recovery re-drives it — so a crash mid-compensation re-derives the cancel intent from the persisted status and finishes the cancel (a compensating cancel is now crash-durable). A non-compensating `cancel()` is unchanged (straight to `cancelled`). For a remote/polyglot workflow (no TS-side compensations) a `cancelling` run finalizes deterministically to `cancelled`.

  **stores (mikro-orm / typeorm / prisma / drizzle):** `listIncompleteRuns()` now also returns `cancelling` runs so recovery re-drives a compensation interrupted by a crash. Columns are free strings — no migration.

  **dashboard / telescope:** render `cancelling` with a distinct in-progress amber (it pulses like a live run; distinct from the grey terminal `cancelled`), add it to the status filter and the state-breakdown chart.

  **codegen:** generated run-status union types include `'cancelling'`.

## 0.13.2

### Patch Changes

- e5b494d: Align durable-table collation to the ORM's configured `collate` (MySQL/MariaDB).

  MikroORM's auto-schema (`getUpdateSchemaSQL`) creates tables with the server's DEFAULT collation — on MySQL 8.4 that's `utf8mb4_0900_ai_ci` — and ignores the `collate` config option. When the host app pins a different collation on its own tables (commonly `utf8mb4_unicode_ci` via migrations), a JOIN between a durable table and an app table throws `Illegal mix of collations`.

  `ensureMikroOrmDurableSchema` now converges this after the additive pass: it reads the ORM's configured `collate` and `ALTER … CONVERT TO`s only the durable tables whose collation differs. Idempotent (matching tables are skipped), non-fatal (a failed CONVERT is warned, never crashes boot), and a no-op when no `collate` is configured or the platform isn't MySQL/MariaDB. This fixes both pre-existing tables and ones freshly created by auto-schema.

## 0.13.1

### Patch Changes

- 2c55fa1: Make `ensureMikroOrmDurableSchema` resilient to legacy type-alignment failures.

  A column type alignment (e.g. a legacy `longtext` column → `json`) can fail when an existing value can't cast to the target type — classically a checkpoint `events` blob truncated under an older `text` column (invalid JSON). Previously this crashed boot on every restart. Now a failed non-structural statement (a `modify`/type change) is logged and skipped — the column already holds the data and the store reads/writes it via serialization, so it stays functional — while a failed required statement (`create table` / `add column` / `add index`) still throws. Repair the underlying data out of band to converge the type.

## 0.13.0

### Minor Changes

- f273457: Dispatch priority now reaches the broker, end-to-end.

  - `ctx.call(step, input, { priority })` and `ctx.child(workflow, input, { priority })` carry their
    priority onto the dispatched `RemoteTask` / `WorkflowTask`. The third arg of `ctx.child` /
    `ctx.startChild` accepts `{ childId?, priority? }` (a bare string is still shorthand for `childId`).
  - The BullMQ transport forwards that priority to the job's `priority` option, translating the
    engine's "higher = more urgent" scale onto BullMQ's inverse "lower = more urgent" so one convention
    holds end-to-end. Jobs without a priority keep the FIFO default path.
  - `WorkflowRun.priority` is persisted by every store adapter (MikroORM, Drizzle, TypeORM, Prisma) so
    the priority survives the store round-trip that precedes each remote-workflow advance. Additive,
    nullable column — auto-schema/self-heal adds it to existing tables.

## 0.12.0

### Minor Changes

- 39812a2: Add `deleteRun` to hard-delete a run and its rows.

  New `StateStore.deleteRun(runId)` removes a run plus its checkpoints, signal waiters, and normalized search-attribute rows — implemented in the in-memory store and all four ORM adapters (mikro-orm, typeorm, prisma, drizzle), forwarded by `CodecStateStore`, and covered by the shared store conformance contract. `WorkflowEngine.deleteRun(runId)` builds on it to hard-delete a run and cascade depth-first to its whole subtree (via `getRunChildren`), returning the number of runs removed.

  Unlike `cancel` (which marks a run `cancelled` but keeps it as history), `deleteRun` REMOVES the run — it no longer appears in `getRun`/`listRuns`. Intended for purging a finished run whose data is being deleted; prefer `cancel` first for a live run.

## 0.11.1

### Patch Changes

- e8afff9: `ensureMikroOrmDurableSchema` now manages only the store's own `durable_*` tables instead of running
  a whole-ORM `orm.schema.update({ safe: true })`.

  The recommended setup shares the host app's MikroORM instance (a single ORM avoids MikroORM's
  global-metadata clobber between instances). But a whole-ORM `schema.update()` reconciles EVERY table
  to the entity metadata — on a migration-managed app that means it tries to recreate the migrator's
  table (`Table 'mikro_orm_migrations' already exists`) and drop the app's foreign keys, so the durable
  auto-schema crashed app boot (and would churn/destroy schema if it didn't). It also meant a fresh DB
  (e.g. an ephemeral CI database) never got the durable tables when the host disabled the broken
  auto-schema.

  Now it computes the safe additive diff (`getUpdateSchemaSQL({ safe: true })`) and executes only the
  statements that target the `durable_*` tables. `getUpdateSchemaSQL` emits a `create table` only for a
  missing table and `alter table ... add` only for a missing column, so this stays idempotent: missing
  durable tables are created, existing ones are extended additively, and the rest of the host schema —
  app tables and the migrations table — is never touched. Auto-schema (and calling this from a
  migration) is now safe on a shared, migration-managed ORM.

## 0.11.0

### Minor Changes

- 673de96: Make the MikroORM store's physical column naming an explicit, configurable choice instead of an
  implicit dependency on the host ORM's naming strategy.

  The durable entities previously declared no column names, so the physical columns were whatever the
  host MikroORM's naming strategy produced (its default `UnderscoreNamingStrategy` → `snake_case`). The
  TypeORM and Prisma adapters, by contrast, defaulted to the verbatim camelCase property name. Nothing
  pinned the two together, so the adapters silently disagreed on column names — and swapping a deployed
  app from the TypeORM store to the MikroORM store failed at runtime with `Unknown column 'created_at'`
  against the existing (camelCase) table. The divergence was invisible because each adapter's
  conformance suite creates and reads back its _own_ schema.

  `@dudousxd/nestjs-durable-store-mikro-orm` now exposes `durableEntities({ naming })`, which pins
  explicit column names onto the entity schemas per the chosen convention:

  - `'snake_case'` (default) — the canonical convention, matching the Drizzle adapter.
  - `'preserve'` — the verbatim camelCase property name, for an app whose tables were created by the
    old TypeORM/Prisma adapter and that wants to swap to the MikroORM store with **no migration**.
  - a `(property) => string` function for any custom mapping.

  `ENTITIES` is unchanged in spirit — it is now `durableEntities()` (canonical `snake_case`). The store
  keeps resolving column names from ORM metadata, so it adapts to whichever naming the entities were
  registered with.

  `@dudousxd/nestjs-durable-testing` adds `DURABLE_CANONICAL_COLUMNS` (the canonical snake_case column
  contract) and `assertDurableColumns()` — the cross-adapter guard the project lacked. Each adapter can
  now assert its physical columns against one source of truth, so a future divergence is a failing unit
  test instead of a production "Unknown column".

## 0.10.0

### Minor Changes

- dde1fde: Support MikroORM v7. The adapter now targets `@mikro-orm/core` ^7 (peer dependency),
  aligning it with `@dudousxd/nestjs-filter-mikro-orm` and MikroORM-v7 host apps. Store
  behavior is unchanged — the shared state-store conformance contract passes on v7 against
  SQLite, MySQL, and Postgres.

  BREAKING: requires MikroORM v7 (`@mikro-orm/core` ^7) and `@mikro-orm/decorators` ^7 as
  peer dependencies; `@mikro-orm/better-sqlite` is replaced by `@mikro-orm/sqlite` in v7.
  Hosts still on MikroORM v6 should stay on the previous version of this adapter.

## 0.9.1

### Patch Changes

- b7267da: perf: `getEvent` and `getRunChildren` use targeted store queries instead of fetching and JS-filtering every checkpoint for a run. Adds two **optional** `StateStore` methods (`getLatestCheckpointByName`, `listCheckpointsByNamePrefix`) implemented by all first-party adapters; the engine falls back to the previous `listCheckpoints` scan when a custom store omits them, so this is non-breaking. Cuts per-call rows fetched from O(N) to O(1)/O(k).

## 0.9.0

### Minor Changes

- 687face: Ecosystem improvements across the durable runtime, stores, transports, and tooling.

  ### Scheduling

  - **Schedule jitter + backfill.** Cron/interval schedules can now spread fire
    times with configurable jitter to avoid thundering-herd dispatch, and missed
    occurrences (e.g. while a worker was down) can be backfilled deterministically.

  ### Cancellation

  - **Cancel-by-event.** New `cancelWhere(filter)` cancels all matching runs by a
    declarative filter, complementing single-run cancellation.

  ### Search attributes

  - **Indexed search-attribute side-table pushdown.** Equality and range queries
    over search attributes are pushed down into an indexed side-table across every
    store — TypeORM, MikroORM, Prisma, Drizzle, and the in-memory store — instead
    of scanning and filtering in application code. The side-table is re-indexed on
    update so stale attribute values stop matching.

  ### Singleton admission

  - **Backpressure + notify-on-release + `maxQueueDepth`.** Singleton admission now
    applies backpressure with a configurable `maxQueueDepth`, and waiters are
    notified on release rather than polling.

  ### Queue

  - **Priority + per-key fairness.** The work queue supports per-message priority
    together with per-key fairness so that one busy key cannot starve others.

  ### Context propagation

  - **Opaque context carrier.** Context is now propagated through an opaque carrier,
    decoupling callers from the underlying transport/trace representation.

  ### Packaging

  - **Dual ESM/CJS publish.** Packages now ship both ESM and CJS builds. Decorator
    packages are built via SWC with `legacyDecorator` + `decoratorMetadata` to
    preserve emitted metadata; `testing`, `cli`, and `eslint-plugin` remain
    CJS/ESM as appropriate by design.

  ### Testing

  - **Testcontainers-backed integration specs.** BullMQ, SQS, DB, and Prisma now
    have testcontainers-backed integration specs that run under `test:db`, plus a
    fix to the BullMQ dispatch test shape.

## 0.8.0

### Minor Changes

- dcc97fd: Make in-flight local steps visible. A local `ctx.step` now announces its body has started — emitting a `step.started` lifecycle event and (by default) persisting a `running` checkpoint — so a long-running step shows up in the dashboard the moment it begins, not only once it completes. Previously a local step was checkpointed only on completion, so an in-progress step was invisible.

  - New checkpoint status `'running'` for a local step whose body is executing in-process. It's a placeholder overwritten by `completed`/`failed`, and never short-circuits replay (only `completed` does), so a crash mid-body simply re-runs the step.
  - New engine option `trackStepStart` (default `true`). The `step.started` event always fires (the live SSE view sees the start regardless); the flag gates only the extra `running` checkpoint write. Set it to `false` on hot paths with many short local steps to halve their checkpoint writes — at the cost of reload-survivable in-flight visibility.

## 0.7.0

### Minor Changes

- dc5e0f6: Exactly-once transactional steps — `ctx.transaction(name, (tx) => ...)`.

  Runs your DB work and the step's checkpoint in **one** store transaction, so the business write and the "done" marker commit atomically — a crash can never leave the write done-but-not-checkpointed (which a plain `ctx.step` re-runs on recovery). `tx` is the store-native transaction handle (a TypeORM/MikroORM `EntityManager`, a Prisma tx client, or a Drizzle tx); do your writes on it. Needs a SQL store (all bundled SQL adapters implement the new optional `StateStore.transaction`); errors on a store without it. This is the DBOS-style exactly-once guarantee for same-database work.

- 8ba981d: Signal-with-start (durable entities), cancel→child propagation, and low-latency dispatch.

  - **Reliable signals + `signalWithStart`**: a signal sent with no waiter is now **buffered** (FIFO per token) and delivered to the next `waitForSignal` — signals are never lost to timing. `engine.signalWithStart(workflow, input, runId, { token, payload })` / `workflowService.signalWithStart(...)` ensures a run exists then delivers a signal, race-free — the canonical **durable-entity / accumulator** pattern (one long-lived run per key fed events by many calls). New `StateStore.bufferSignal` / `takeBufferedSignal` (custom stores must add them; all bundled adapters do).
  - **Cancellation cascades to children**: `engine.cancel(parent)` now cancels the runs it started via `ctx.child` / `ctx.startChild` (recursively), and no longer clobbers an already-finished run.
  - **Low-latency cross-pod dispatch**: a run enqueued on one instance (e.g. an API pod) nudges worker instances over the control plane (`engine.onEnqueued`) to pick it up at once instead of on the next poll. The dashboard `/metrics` adds `durable_pending_runs` (dispatch backlog) + `durable_dead_runs` (DLQ size) gauges.

## 0.6.0

### Minor Changes

- c99508d: Self-healing recovery + non-blocking dashboard actions.

  - **Lease renewal**: while a run executes, the engine renews its recovery lease (every `leaseMs/2`), so a live worker keeps a long run while a **crashed** worker's lease still expires. `execute` now holds the lease for the whole run on every entry path (sweep, signal, remote result, dashboard), so a run is never double-executed. New `StateStore.renewRunLock(runId, owner, leaseUntilMs)` — **custom stores must add it**.
  - **Periodic orphan recovery**: the NestJS `TimerPoller` now calls `engine.recoverIncomplete()` each tick, so a run orphaned by a crashed worker self-heals within ~`leaseMs` instead of only on the next boot.
  - **Non-blocking control actions** (fixes the `/durable` retry/cancel request hanging): `retry` now re-enqueues via the new `engine.requeue(runId)` (sets `pending` + dispatches) and `cancel({ compensate })` runs the undo in the background — neither replays the workflow inline in the HTTP request anymore. A worker does the work.

## 0.5.0

### Minor Changes

- a5fd901: Typed search attributes — query runs by structured data, not just exact-match tag labels.

  - **Start**: `start(wf, input, id, { searchAttributes: { amount: 200, tier: 'pro' } })` stamps typed, queryable data on a run.
  - **Query**: `RunQuery.attributes` takes `{ key, op, value }` predicates ANDed together, with `eq/ne/gt/gte/lt/lte` — so range queries like `amount >= 200 AND tier = 'pro'` work. Applied in-process after the coarse workflow/status/tag filters, so it's portable across all store adapters (typeorm/prisma/mikro-orm/drizzle gain a `searchAttributes` JSON column).
  - **Dashboard**: an attribute filter box (`amount:gte:200, tier:eq:pro`), attribute pills on the run detail, and bulk retry/cancel honoring the same predicates. API: `GET /runs?attr=key:op:value` (repeatable).

## 0.4.0

### Minor Changes

- f2260da: feat: named events — ctx.waitForEvent + engine.publishEvent

  Name-based pub/sub on top of the signal machinery, for choreography beyond point-to-point signals. A
  run suspends on `ctx.waitForEvent('payment.settled', { match: { orderId }, timeoutMs })` and resumes
  with the payload; `engine.publishEvent(name, payload)` (also `WorkflowService.publishEvent`) fans out
  to every waiting run whose `match` the payload satisfies, returning how many it resumed. The match is
  encoded in the waiter token, so the only store change is a new `listSignalWaiters(prefix)` method
  (implemented across in-memory, TypeORM, MikroORM, Prisma, Drizzle) — no new schema.

## 0.3.0

### Minor Changes

- 685258f: feat: workflow tags + search

  Label runs and search/filter by them in the dashboard. Tags come from two sources, merged onto each
  run:

  - **Static** — `@Workflow({ name: 'pipeline', tags: ['etl', 'critical'] })` stamps every run of the
    workflow.
  - **Per-run** — `WorkflowService.start(wf, input, runId, { tags: ['nightly'] })` (and
    `engine.start(..., { tags })`) adds run-scoped tags.

  `WorkflowRun.tags` is stored across all store adapters (in-memory, TypeORM, MikroORM, Prisma,
  Drizzle), and `RunQuery.tag` filters by an exact tag. The dashboard shows tags on each run (list +
  detail) and adds a tag filter box; clicking a tag filters the list. The dashboard API gains a
  `?tag=` query param.

## 0.2.1

### Patch Changes

- 6979d60: fix: list runs newest-first

  `store.listRuns` now orders by `createdAt DESC` (was `ASC`) across every adapter (in-memory,
  TypeORM, MikroORM, Prisma, Drizzle), so the dashboard shows the most recent run on top instead of
  buried at the bottom.

## 0.2.0

### Minor Changes

- 3f79533: feat: dead-letter queue — `maxRecoveryAttempts` + `dead` run status

  Crash recovery now counts attempts per run (`WorkflowRun.recoveryAttempts`); once a still-`running`
  run exceeds the engine/module `maxRecoveryAttempts`, it's moved to the new terminal **`dead`** status
  instead of being retried forever — so a poison pill that crashes the process every boot becomes an
  inspectable dead-letter entry, not a crash loop. The new column is persisted by all four store
  adapters (TypeORM auto-schema self-heals it; Prisma/Drizzle/MikroORM schemas updated), and `dead` is
  added to the dashboard/codegen status unions. Omit `maxRecoveryAttempts` for the prior unlimited-retry behaviour.

## 0.1.4

### Patch Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

## 0.1.3

### Patch Changes

- `ctx.call` now **suspends the run durably** instead of awaiting the worker result in memory. The
  remote step writes a `pending` checkpoint, the run suspends, and the result resumes it on whichever
  engine instance receives it — so a worker/control-plane pod can scale down or crash mid-step without
  losing the run or re-running completed work. This makes `ctx.call` consistent with `ctx.task` /
  `ctx.sleep` (already durable). A step that sets `timeoutMs` keeps the in-memory await + heartbeat path
  (opt-in liveness, single-instance).

  **Breaking:** `engine.start()` / `WorkflowService.start()` now returns `suspended` (not `completed`)
  for a workflow that hits a remote `ctx.call` — the run finishes asynchronously when the result lands.
  Trigger-and-observe consumers are unaffected; anything that awaited `start()` to completion should
  poll the run status (or react to `run.completed`) instead.

  `StepCheckpoint.status` gains `'pending'` (an in-flight remote step), surfaced in the dashboard as a
  "running" node. In-process transports (event-emitter, the in-memory test transport) now deliver
  results on a later tick so the suspend settles first.

## 0.1.2

### Patch Changes

- Record a step's **input** on its checkpoint, alongside the output. A remote step's `ctx.call` args
  are now persisted and surfaced in the dashboard step panel ("Input" + "Output" shown separately,
  instead of only the output) — so you can see what a step was called with, not just what it returned.
  Stored as a nullable column across all four store adapters; the in-memory store carries it for free.

## 0.1.1

### Patch Changes

- Add native step timing/status: checkpoints now record `enqueuedAt` (dispatch) →
  `startedAt` (worker pickup) → `finishedAt` (done), so you can see how long a step
  waited in the queue before a worker began processing it (queue-wait =
  `startedAt − enqueuedAt`). The worker's start time flows back through the single
  `runStepHandler` choke point, so every transport reports it for free. A new
  `step.started` event announces a remote step as in-flight, and `step.completed` /
  `step.failed` events carry `queueMs`. The dashboard step panel surfaces the queue
  time alongside the processing duration. Stored as a nullable column with a
  back-compat fallback to `startedAt` for rows written before this release.
