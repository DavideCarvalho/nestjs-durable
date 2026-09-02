# @dudousxd/nestjs-durable-store-prisma

## 0.17.0

### Minor Changes

- 1171860: Multi-value run predicates, and the distinct values behind them

  `RunQuery` could only ever ask for ONE tag, ONE tenant, ONE origin. An operator comparing two
  tenants, or looking at two kinds of run, had to issue two queries and read two lists.

  ```ts
  store.listRuns({ tags: ["etl", "nightly"], namespaces: ["acme", "globex"] });
  store.listRuns({ origins: ["@acme/billing", null] }); // …plus the runs nothing claims
  store.listRuns({
    attributes: [{ key: "tier", op: "in", values: ["pro", "enterprise"] }],
  });
  ```

  `workflows`, `statuses`, `tags`, `namespaces` and `origins` each OR within themselves and AND with
  everything else; an empty set matches nothing, mirroring the `statuses` field that already worked
  this way. `origins` carries `null` as a member, which is the one thing the single `origin` cannot
  express: "this package plus the runs nothing could attribute".

  `AttributeFilter` gains an `in` op, carrying a `values` SET. It needs to be its own operator because
  two `eq` predicates on the same key are ANDed like every other pair, and no run has one attribute
  with two values — so without it, a multi-select over attribute values always returns nothing.

  **`StateStore.runValueFacets`** (optional, like `runFacets`) answers the other half: the distinct
  values of one filter axis over the runs matching a query, with counts. It is what lets a console
  offer a picker instead of a text box — every offered value returns runs, and the counts say how
  many. The run-table axes are an exact `GROUP BY`; `tag` and the search-attribute axes live outside
  the row (a JSON array, a side table) and are counted over a bounded scan of recent matching runs,
  which `RunValueFacetOptions.scan` documents and bounds.

  `RunGateway` gains the same method, so it works on a tenant deployment (no store, proxying over the
  transport) as well as on the control plane.

## 0.16.0

### Minor Changes

- 89f9377: The console stays responsive on a control plane with tens of thousands of runs

  Measured against a live deployment holding 9,533 runs, the console was unusable: `GET /runs` returned
  **12.24 MB** (uncompressed) every 3 seconds, the run list mounted **115,636 DOM nodes**, and the tab
  spent **26.9 of every 30 seconds** with its main thread blocked — a 16-second freeze on open, then
  ~4 seconds on every poll. Opening a long run (488 checkpoints) blocked it for another 21 seconds.
  The same measurements now read **0.24 s** and **0 ms of steady-state freeze**.

  What changed:

  - **The run list is a page.** `GET runs` accepts `limit`/`offset` (every store already implemented
    them; the console simply never sent them) and the SPA fetches 100 rows, virtualised so only the
    visible ones are mounted, with "show more" to go further back.
  - **New `runs/facets` endpoint**, backed by `StateStore.runFacets` / `RunGateway.runFacets` — one
    `GROUP BY status, origin` aggregate. This is what makes paging safe: the page bounds what is
    rendered, the status and origin chips still report the whole matching set.
  - **`RunQuery.origin` accepts `null`** to select runs carrying no origin (`origin IS NULL`). The
    console's "unknown" facet used to be applied in the browser precisely because an exact-match filter
    cannot express absence, which meant it needed every run in memory to work. It is now a server-side
    predicate, on the list and on bulk actions alike.
  - **The list endpoint returns rows, not runs.** `input`, `output` and `error` are omitted — on the
    deployment measured, `error` alone (a stack trace per failed run) was 63% of the payload, and no
    list row reads any of the three. `GET runs/:id` is unchanged.
  - **`GET runs` accepts a repeated `status` param** (`?status=running&status=suspended`), ORed into
    `RunQuery.statuses`. A single value still narrows to that status exactly as before.
  - **The detail pane no longer re-lays-out a run on every poll.** It, the workflow graph and the span
    timeline are memoised, the graph culls off-screen nodes, and the run detail's own sibling lookup
    went from listing every run every 3 seconds to a bounded query issued only for singleton runs.
  - **The "no live worker" banner reads worker health** rather than the runs on screen, so it cannot go
    quiet just because the stalled runs fell off the page.

  Nothing is required of consumers: absent `limit`/`offset` still returns the whole listing, and
  `runFacets` is optional on `StateStore` (a store without it falls back to counting a listing).
  `RunGateway` implementors must add `runFacets`.

## 0.15.0

### Minor Changes

- 9ae1bf3: Enforce the `namespace` tenant boundary in the Prisma store.

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

## 0.14.0

### Minor Changes

- 0203613: Persist and filter on a run's `origin`.

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
    `ALTER TABLE durable_workflow_runs ADD COLUMN origin TEXT;` runs, _every_ run query fails, because
    drizzle selects all declared columns. Same trap `priority` set.
  - **prisma** — the nullable model field emits the ADD COLUMN through Migrate; existing rows land NULL.

  No index. `namespace` is indexed because every poll tick filters on it; `origin` is touched only by the
  dashboard's listing, ANDed with `status` and `workflow`, which are indexed already. A deployment that
  makes origin-filtered listings hot should add the composite index in its own migration — one added
  here would never reach a database that has already booted.

## 0.13.0

### Minor Changes

- d023e95: **Events gain the same lost-wake protection `ad5c510` gave signals.** Before this release,
  `engine.publishEvent` silently DROPPED a publish that matched no live `ctx.waitForEvent` waiter, and
  `waitForEvent` never consulted any buffer — the same class of bug the prior signal-race fix closed,
  just unfixed for events (e.g. a webhook/event source firing before the workflow reached its
  `waitForEvent` call would lose that event forever).

  Semantics (mirrors `signalWithStart`'s reliability contract for signals, documented on
  `engine.publishEvent`):

  - A publish that resumes ≥1 live waiter, or routes into an `eventBatch` accumulator / starts ≥1
    `onEvent` subscriber, behaves exactly as before and is NOT buffered — fan-out stays live-only.
  - A publish that touches NOBODY buffers ONE copy (`opts.buffer: false` opts out), consumed by the
    FIRST future `waitForEvent(name, { match })` whose match accepts it — point-to-point on redelivery,
    by design, even though the live path above is fan-out. `opts.id` dedupe still applies to subscriber
    starts only.
  - Right after buffering, `publishEvent` re-checks for a waiter that registered in the sliver between
    the initial miss and the buffer write (sandwich parity with `signal`'s own take → buffer → recheck);
    `waitForEvent` does the mirror-image check right after registering. UNLIKE `waitForSignal`, an event
    token embeds the call's own `runId#seq` (never reused across iterations the way a signal token can
    be), so there is no entity-loop-reuse hazard from registering before checking — a single
    post-registration scan closes the race.
  - New engine option `eventBufferTtlMs` (default unset = keep until consumed, like buffered signals):
    when set, the due-timer reconcile pass prunes expired buffered events for the names it already
    touches during its sweep.

  New SPI: `StateStore.bufferEvent`/`listBufferedEvents`/`removeBufferedEvent` (a new
  `durable_buffered_events` table, name-keyed with match-based consumption rather than the token-keyed
  blind-take `bufferSignal`/`takeBufferedSignal` uses — the match predicate belongs to the WAITER, so
  consumption is list + evaluate locally + atomically claim), implemented across every first-party store
  (in-memory, MikroORM, Drizzle, Prisma, TypeORM) with a shared conformance case. The remote/polyglot
  workflow-command protocol has no `waitEvent` command — events remain reachable only from in-process
  `ctx.waitForEvent` and `engine.publishEvent`, not from a remote-executor workflow; extending that
  protocol is future work, not invented here.

  **`nestjs-durable-dashboard` gains first-class `guards`/`imports` options** on
  `DurableDashboardModule.forRoot(...)`, mirroring `@dudousxd/nestjs-agent-dashboard`'s console exactly:
  guard classes are stamped onto BOTH the UI (page) controller and the JSON API controller via
  `@nestjs/common`'s own `@UseGuards` metadata key (replace, not append, on a repeated `forRoot` call),
  and `DurableApiModule` is now a dynamic module so a guard's own dependencies resolve from the host's
  `imports` instead of failing to boot with "Nest can't resolve dependencies ... in the DurableApiModule
  context". Documents the header-vs-cookie reality for the two mount points: the JSON API is fetched by
  the SPA's own JS (a header-based guard works normally), but the UI shell is a full-page browser
  navigation with no custom header — only an ambient cookie (or no guard at all) reaches it there.

## 0.12.0

### Minor Changes

- ad5c510: Fixes a lost-wake race in signal delivery: a signal (e.g. an agent HITL approve/reject) delivered
  in the narrow window between a waiter's buffered-check and its waiter-row registration used to be
  lost forever — the run stayed suspended, the buffered payload sat unpaired, and nothing ever paired
  them (observed in production: the SSE stream never closed).

  Three-piece fix:

  1. **Waiter side** (`waitForSignal`'s both arms, and the remote `waitSignal` command): re-check the
     buffer once more immediately after registering the waiter, so a signal that raced in during the
     initial check is still caught before suspending. On a hit, the waiter removes its OWN row via the
     new exact-match `removeSignalWaiter` — never a blind `takeSignalWaiter(token)`, which deletes ANY
     row for that token and could otherwise steal a different run's waiter that has since claimed the
     same token (`token` is the store's primary key).
  2. **Signal side** (`engine.signal`): after buffering a signal nobody was waiting for, re-check for a
     waiter that registered in that same window; if one appears, reclaim the buffer and deliver
     directly instead of leaving both rows stranded.
  3. **Reconcile safety net**: the due-timer pass that already re-drives event-wait suspends (via their
     `reconcileMs` fallback `wakeAt`) now also pairs a stranded buffer + waiter for a suspended run in
     that batch — closing the residual window where a crash lands between the two ops on either side
     and neither side's own retry logic ever runs again.

  New SPI: `StateStore.removeSignalWaiter(waiter)` deletes the exact `(token, runId, seq)` row (a
  no-op if it no longer matches), implemented across every first-party store (in-memory, MikroORM,
  Drizzle, Prisma, TypeORM) with a shared conformance case.

  Regression-covered: normal (non-racing) signal/`waitForSignal` behavior, the `signalWithStart`
  long-lived entity loop, and the timeout arm (which now cleans up only its own waiter row) are all
  unchanged. Also fixes an unrelated TOCTOU this work surfaced: a `ctx.all` `failFast` cancel landing
  on a sibling mid-turn could be clobbered back to `suspended` by that sibling's own (now-stale) settle
  — `engine`'s suspend-settle re-checks for a concurrent cancel before writing.

## 0.11.6

### Patch Changes

- 25f8000: Add `durableManagedTables()`, returning the fixed list of tables this store creates/manages (`durable_workflow_runs`, `durable_step_checkpoints`, `durable_run_attributes`, `durable_signal_waiters`, `durable_buffered_signals`). Feed it to your ORM's migration differ exclude/skipTables list so a schema diff never proposes dropping them, instead of hand-maintaining a regex denylist (e.g. `skipTables: [/^durable_/]`) that can drift from what the store actually owns.

## 0.11.5

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

## 0.11.4

### Patch Changes

- 99e78fb: Remote `startChild` / `gather_children` child-await `signal:child:` checkpoints now carry the command's `parallelGroup`. The fan group is threaded `command → signal waiter → checkpoint`: the engine stamps each child waiter with the awaiting `startChild` command's group, and the resolving `signal:child:<id>` checkpoint (written when the child notifies the parent) inherits it. Each store adapter persists a nullable `parallel_group` column on the signal-waiter row so it round-trips `put → take`. As a result the dashboard renders a cross-SDK parallel child fan-out (e.g. a Python `ctx.gather_children`) stacked vertically as one parallel group instead of a misleading horizontal `start → s1 → … → sN → end` sequential chain. Additive and backward-compatible: existing waiter rows simply have a NULL group.

## 0.11.3

### Patch Changes

- 6b5256b: Make `releaseRunLock` idempotent. It now uses `updateMany` instead of `update`, so releasing the lease on a run that no longer exists is a no-op rather than throwing Prisma's P2025 (`No record was found for an update`). The engine calls `releaseRunLock` best-effort in a `finally` after a run settles, which can race a concurrent purge/teardown; the old `update({ where: { id } })` surfaced that race as an unhandled rejection. This now mirrors the in-memory store's `if (run)` guard and the set-where semantics of the TypeORM/MikroORM/Drizzle adapters.

## 0.11.2

### Patch Changes

- 1738393: Persist `parallelGroup` on step checkpoints (parity with the mikro-orm adapter). A `ctx.gather`/`ctx.all` fan tags every sibling step with the same group so the dashboard renders them as one "ran in parallel" group, and the core engine carries it (including from a remote/polyglot worker's `recordStep`) — but these adapters had no column for it, so it was dropped on insert and read back as `undefined`, leaving the fan rendered as N sequential rows. Adds a nullable `parallel_group` column to the checkpoint table and maps it in both directions.

  - **typeorm**: auto-added on boot by `ensureTypeOrmDurableSchema` (no manual migration).
  - **drizzle / prisma**: the column is added to the schema/model; consumers manage their own schema, so apply a migration adding the nullable `parallel_group` column (e.g. `prisma migrate` / a drizzle migration). The reference `schema.prisma` now includes it.

## 0.11.1

### Patch Changes

- c1aaacd: Add a transient `cancelling` run status so a compensating cancel is visible (and durable) instead of looking like a still-`running` run.

  **core:** `RunStatus` gains a non-terminal `'cancelling'`. `cancel(runId, { compensate: true })` now persists `cancelling` immediately (and returns it) while the background saga undo runs, then flips to `cancelled` — previously the run stayed `running`/`suspended` with no outward signal that a cancel was in flight. A repeat compensating cancel is idempotent. The status is treated as in-flight everywhere it must be: the singleton admission gate counts it, and recovery re-drives it — so a crash mid-compensation re-derives the cancel intent from the persisted status and finishes the cancel (a compensating cancel is now crash-durable). A non-compensating `cancel()` is unchanged (straight to `cancelled`). For a remote/polyglot workflow (no TS-side compensations) a `cancelling` run finalizes deterministically to `cancelled`.

  **stores (mikro-orm / typeorm / prisma / drizzle):** `listIncompleteRuns()` now also returns `cancelling` runs so recovery re-drives a compensation interrupted by a crash. Columns are free strings — no migration.

  **dashboard / telescope:** render `cancelling` with a distinct in-progress amber (it pulses like a live run; distinct from the grey terminal `cancelled`), add it to the status filter and the state-breakdown chart.

  **codegen:** generated run-status union types include `'cancelling'`.

## 0.11.0

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

## 0.10.0

### Minor Changes

- 39812a2: Add `deleteRun` to hard-delete a run and its rows.

  New `StateStore.deleteRun(runId)` removes a run plus its checkpoints, signal waiters, and normalized search-attribute rows — implemented in the in-memory store and all four ORM adapters (mikro-orm, typeorm, prisma, drizzle), forwarded by `CodecStateStore`, and covered by the shared store conformance contract. `WorkflowEngine.deleteRun(runId)` builds on it to hard-delete a run and cascade depth-first to its whole subtree (via `getRunChildren`), returning the number of runs removed.

  Unlike `cancel` (which marks a run `cancelled` but keeps it as history), `deleteRun` REMOVES the run — it no longer appears in `getRun`/`listRuns`. Intended for purging a finished run whose data is being deleted; prefer `cancel` first for a live run.

## 0.9.1

### Patch Changes

- 6f4e59e: Fix: map every patchable field in the Prisma and Drizzle `updateRun` implementations (previously a subset of fields could be silently dropped on partial updates).

  Internal engine refactors (behavior-preserving): extract `SingletonGate` to concentrate the singleton feature, funnel run settle/suspend transitions through a single `settleRun()`, and extract a `stepCheckpoint()` factory deduping 8 hand-built literals.

## 0.9.0

### Minor Changes

- 0881bb1: Pin the TypeORM and Prisma adapters to the canonical `snake_case` physical column names, so all four
  store adapters (MikroORM, Drizzle, TypeORM, Prisma) agree on the schema and a run written by one is
  readable by another. Each adapter now asserts its physical columns against the shared
  `DURABLE_CANONICAL_COLUMNS` contract (`@dudousxd/nestjs-durable-testing`), so a future divergence is a
  failing unit test instead of a runtime `Unknown column`.

  **store-typeorm** — entities are now built by `durableEntities({ naming })` (a TypeORM `EntitySchema`
  factory mirroring the MikroORM adapter): `'snake_case'` default, `'preserve'` for verbatim camelCase,
  or a custom `(property) => string`. `ensureTypeOrmDurableSchema` and the search-attribute `EXISTS`
  pushdown now resolve column names from the entity metadata (via a shared `durableColumnResolver`)
  instead of hardcoding them, so the raw SQL can never drift from the entity mapping.

  **store-prisma** — every multi-word field gains `@map("snake_case")` (Prisma is static codegen, so it
  has no runtime naming choice — it is pinned to the canonical convention).

  **BREAKING** for existing deployments whose `durable_*` tables were created by the _old_ camelCase
  schema of these adapters:

  - **TypeORM**: register entities with `durableEntities({ naming: 'preserve' })` to keep reading the
    existing camelCase tables with no migration.
  - **Prisma**: there is no runtime override — migrate the columns to `snake_case` (e.g.
    `ALTER TABLE ... RENAME COLUMN`) before upgrading, ideally alongside the deploy so older pods don't
    re-create camelCase columns.

## 0.8.1

### Patch Changes

- b7267da: perf: `getEvent` and `getRunChildren` use targeted store queries instead of fetching and JS-filtering every checkpoint for a run. Adds two **optional** `StateStore` methods (`getLatestCheckpointByName`, `listCheckpointsByNamePrefix`) implemented by all first-party adapters; the engine falls back to the previous `listCheckpoints` scan when a custom store omits them, so this is non-breaking. Cuts per-call rows fetched from O(N) to O(1)/O(k).

## 0.8.0

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

## 0.1.3

### Patch Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

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
