# @dudousxd/nestjs-durable-telescope

## 0.8.1

### Patch Changes

- 4559f11: Add NestJS 12 to the supported peer range

  NestJS 12 ships its core packages as pure ESM and requires Node >= 20.19. These packages are already
  `"type": "module"`, so nothing in the source had to change — but their `@nestjs/*` peer ranges topped
  out at `^11`, which is enough for a host app on 12 to get an unmet-peer warning or, on a strict
  installer, a refused install.

  `@nestjs/common` and `@nestjs/core` now accept `^10.0.0 || ^11.0.0 || ^12.0.0`, and
  `@nestjs/event-emitter` — whose own line jumped straight from 3.x to 12.x to track the framework —
  accepts `^2.0.0 || ^3.0.0 || ^12.0.0`. The dev dependencies moved to the 12.x line as well, so the
  suite that guards the module wiring, the lifecycle hooks and the in-app worker now runs against
  NestJS 12 rather than only claiming to support it.

## 0.8.0

### Minor Changes

- d8dc3cc: Give every workflow turn and every step handler a Telescope batch, so what durable work _does_ is
  correlated to the work that did it.

  `@dudousxd/nestjs-durable-telescope` opened no batch at all. It subscribed to engine events and
  recorded an entry per event, which tells you that `step.failed` happened — and nothing about what the
  step was doing when it failed. The queries it issued, the outbound calls it made and the exception it
  threw were recorded by Telescope's other watchers with no batch and no trace context active, so they
  landed traceless: unfindable from the run, and invisible in the trace waterfall. Recording an event
  after the fact cannot fix that, because by then the body has returned.

  **The seam.** Wrapping execution needed a hook, and the engine's existing one is the wrong shape:
  `engine.use` (`StepInterceptor`) fires only around the in-process `localStep` primitives —
  `ctx.now`, `ctx.sideEffect`, `ctx.task`'s dispatch step, saga compensations — because a user's
  `ctx.step` is _always dispatched_, so its handler runs inside a transport callback or a worker
  process where no engine is in scope at all. So core gains a process-level registry,
  `useDurableExecution(wrapper)`, folded in at the three places a unit of durable work actually
  executes:

  - `WorkflowEngine.runExecution` — one whole TS workflow turn, including the store writes that bracket
    the body, because those are precisely the queries you want attributed to the turn that issued them;
  - `runStepHandler` in core's `protocol.ts` — the one function every transport (BullMQ, SQS,
    event-emitter, DB, in-memory) funnels a step handler through;
  - `StepWorker.processTask` / `WorkflowWorker.processTask` in `@dudousxd/durable-worker` — the same
    two units on the thin/co-located worker path, which has no engine to hang a hook off. That is why
    the registry is process-level rather than per-engine.

  Nothing is registered by default: with an empty registry `runDurableExecution` returns the body's own
  promise without allocating a chain, so a host that wires no observability pays nothing. A wrapper's
  return value and its throws are deliberately discarded — the body's outcome is the only thing that
  can settle the call, so a misbehaving observer can never turn a failed step into a completed one and
  corrupt a run's history.

  **The trace.** The watcher previously held a live root span per run and ended it on `run.suspended`,
  which fragments a durable workflow into one trace per turn — the failing step in a different trace
  from the turn that dispatched it. The trace id is now **derived from the run id**, so a run is one
  trace no matter how many times it suspends, how long it waits, or how many processes execute it — a
  worker elsewhere derives the same id from the same id. Lifecycle entries state that trace id
  explicitly, so an event emitted outside any execution scope (a remote step's result landing in a
  transport callback, a recovery sweep) is still findable from the run.

  **Nesting.** A unit reuses the open batch when _this_ Telescope wiring already has one for _this_ run
  on the current async path; anything else opens a fresh one. The consequence differs by transport and
  is worth knowing before you meet it: with an in-process transport the step handler runs inside the
  turn that dispatched it and its result resumes the next turn on the same path, so the whole run is
  one batch — it genuinely is one causal chain; with a queue-backed transport each turn and each step
  is a separate entry point in a separate process and gets its own. A child workflow is a different
  run, so it always gets its own batch and its own trace. The `traceId` is the invariant that holds
  across every shape.

  **Origin.** Batches are recorded as `origin: 'queue'`. Telescope's `BatchOrigin` is the closed union
  `'http' | 'queue' | 'schedule' | 'cli' | 'manual'` with no durable/workflow member; widening it
  belongs to that repo and a coordinated release, and `'queue'` is accurate anyway — durable work
  reaches an executor by being dispatched over a transport, exactly like the jobs the BullMQ watcher
  marks `'queue'`.

  **New: `durableTraceContext()`.** Telescope resolves an entry's trace id from an ambient OTel span,
  and `@opentelemetry/api` alone propagates nothing — without a registered context manager
  `context.with(...)` is a no-op. An app running no OTel SDK (most of them) would therefore get
  correlated batches and null trace ids. Pass `TelescopeModule.forRoot({ traceContext:
durableTraceContext() })` and entries recorded by the _other_ watchers during a turn or step pick up
  the run's trace too. An app that does run a full OTel SDK keeps `OtelTraceContextProvider` —
  optionally as `durableTraceContext(new OtelTraceContextProvider())`, which consults it first — and
  both agree, because the scope's spans already hang off the run's trace.

  **Not covered, deliberately.** A remote step (a Python handler, say) executes out of process; its
  lifecycle entries carry the run's trace id, but the queries and exceptions inside it are that
  runtime's to record. A remote workflow is likewise unwrapped: the engine dispatches a workflow task
  and awaits a decision rather than executing a body, and a scope around a dispatch would describe the
  wrong thing.

## 0.7.3

### Patch Changes

- a8f8e6d: Tell apart the two blank cells in the Workers table.

  `—` meant both "this worker's heartbeat carries no `WorkerStatus` at all" and "it reports fine, it
  just has nothing to measure yet". Those are different incidents. The first is a fleet that has
  stopped talking, or an SDK too old to; the second is the normal state of an idle deployment —
  `throughputPerMin` and `p95Ms` come off the adaptive controller's rolling window of completions, so
  they are absent until a step finishes inside it, and `lastAdjust` is absent until the controller
  actually moves the limit.

  Rendering both the same way sends a reader hunting for a broken worker that is merely idle. A
  deployment where every `py-flip-*` row showed `—` for Thrpt/min, p95 and Last adjust was exactly
  that: healthy workers, empty window.

  Now `n/a` is "not reported" and `—` is "nothing to measure yet". Mode, limit, in-flight and the
  min–max range are never measurements — a status either declares them or there is no status — so
  their absence is always `n/a`.

## 0.7.2

### Patch Changes

- ad67612: Give the Workers table the full width of its row instead of half the viewport.

  The "Workers" section declared `cols: 2` and held exactly one panel — the eleven-column worker
  table, the widest on the dashboard. A section renders as a fixed `grid-cols-N` grid, one panel per
  cell, with no `colSpan`, so that table got a 575px cell on a 1418px viewport, scrolled sideways
  inside its own card, and left the cell beside it empty. `cols: 1` gives it the whole row.

  A new spec asserts the invariant for **every** section, not just this one: a panel count that is
  not an exact multiple of `cols` leaves a visible hole beside the last row, and it now fails the
  build with the offending section named.

  The `Limit` column is gone with it: `In-flight` renders `<inFlight>/<limit>`, so a Limit column
  beside it repeated its own denominator on every row.

## 0.7.1

### Patch Changes

- 1bd5fe5: Fix: the durable Telescope watcher no longer crashes registration on a store-less thin-worker /
  tenant deployment. In that topology the `WorkflowEngine` token resolves to a start-only
  `DurableStartClient` facade (it proxies run starts over the transport and has no local lifecycle
  event stream — those events live on the operator that holds the store), so calling `engine.subscribe`
  threw `engine.subscribe is not a function` and the watcher failed to register. The watcher now skips
  registration gracefully when the resolved engine exposes no `subscribe`, leaving the rest of
  Telescope unaffected.

## 0.7.0

### Minor Changes

- 4eace00: Observable + adaptive workers. Workers can now self-tune their concurrency and publish a live status
  snapshot on their heartbeat, surfaced per worker in Telescope and the embedded dashboard.

  - **Adaptive concurrency.** The `concurrency` option on every worker surface
    (`BullMQTransport`, `runRedisWorker`, the NestJS in-app worker, the multi-group worker module, and
    the Python `Worker`) now also accepts `'adaptive'` or `{ mode: 'adaptive', min, max, start,
ramCeilingPct, cpuCeilingPct, tickMs }`. A control loop tunes the BullMQ Worker concurrency by an
    AIMD latency-gradient (grows only when saturated, shrinks when latency inflates = queuing), with a
    cgroup-aware RAM ceiling as a hard brake and backpressure on error/stall. A plain number stays
    fixed (default 1) — unchanged. No new dependencies (RAM/CPU read from stdlib + cgroup files).
  - **Worker status on the heartbeat.** The worker-liveness heartbeat value goes from a bare timestamp
    to `{ ts, status }` JSON carrying a `WorkerStatus` (new core type): concurrency mode + live limit,
    in-flight, RSS%, CPU%, throughput/min, p95 latency, and the adaptive controller's last limit change
    (`grow`/`shrink`/`ram_ceiling`/`backpressure`/`cpu_ceiling`). Readers accept both the new JSON and
    the old bare-timestamp form, so a mixed-version fleet reports cleanly.
  - **Telescope + dashboard.** A new `durable.workerStatus` data provider and a "Workers" panel show one
    row per live worker (mode, limit, in-flight/limit saturation, queue depth, RAM%, CPU%, throughput,
    p95, last adjust). The embedded dashboard's worker chips expand to a per-worker breakdown. The
    existing group-level "Worker health" panel is unchanged.

  Note: `@dudousxd/nestjs-durable-transport-bullmq` now depends on `@dudousxd/durable-worker` (it reuses
  the shared adaptive controller). The Python `durable-worker` client gains the same `concurrency`
  knob and status payload (released separately via git tag).

  See `docs/workers-when-to-use.md`.

## 0.6.2

### Patch Changes

- 15437b1: Rename the Workflows dashboard "Starved worker groups" panel to "Worker health".
  The panel lists ALL worker groups (starved sorted first) with a Status column that
  flags STARVED only when a group has queued work and zero live workers — the old
  title read as if every listed group were starved.

## 0.6.1

### Patch Changes

- 7b8027d: Fix state-breakdown pie palette so each status reads with the semantically-correct color (completed=green, failed=red), aligned index-for-index with the status list.
  Deduplicate triplicated run lifecycle events (the engine emits each event on every pod) by `${event}:${runId}` before aggregating, so throughput, success rate, runs-over-time, timeseries and duration are no longer inflated ~3×.

## 0.6.0

### Minor Changes

- c1aaacd: Add a transient `cancelling` run status so a compensating cancel is visible (and durable) instead of looking like a still-`running` run.

  **core:** `RunStatus` gains a non-terminal `'cancelling'`. `cancel(runId, { compensate: true })` now persists `cancelling` immediately (and returns it) while the background saga undo runs, then flips to `cancelled` — previously the run stayed `running`/`suspended` with no outward signal that a cancel was in flight. A repeat compensating cancel is idempotent. The status is treated as in-flight everywhere it must be: the singleton admission gate counts it, and recovery re-drives it — so a crash mid-compensation re-derives the cancel intent from the persisted status and finishes the cancel (a compensating cancel is now crash-durable). A non-compensating `cancel()` is unchanged (straight to `cancelled`). For a remote/polyglot workflow (no TS-side compensations) a `cancelling` run finalizes deterministically to `cancelled`.

  **stores (mikro-orm / typeorm / prisma / drizzle):** `listIncompleteRuns()` now also returns `cancelling` runs so recovery re-drives a compensation interrupted by a crash. Columns are free strings — no migration.

  **dashboard / telescope:** render `cancelling` with a distinct in-progress amber (it pulses like a live run; distinct from the grey terminal `cancelled`), add it to the status filter and the state-breakdown chart.

  **codegen:** generated run-status union types include `'cancelling'`.

## 0.5.1

### Patch Changes

- 1d76da7: Migrate all internal consumers (engine factory, registrars, timer poller, dashboard service, telescope data providers) to the canonical capability tokens, and flip the dual-bind so the canonical token (`@dudousxd/nestjs-durable:state-store`/`:transport`/`:options`) is the real provider while the legacy `nestjs-durable:*` tokens become `useExisting` back-compat aliases. The legacy tokens are now `@deprecated` but still resolve to the same instances — fully non-breaking.

## 0.5.0

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

- f14f991: Redesign the Workflows dashboard as golden-signals sections (Health / Needs
  attention / Trends): success-rate gauge, p95 duration + distribution, backlog and
  throughput with trend, top failing workflows, stuck runs, and a state breakdown.
  Requires `@dudousxd/nestjs-telescope` with the enriched panel IR.

## 0.4.0

### Minor Changes

- 3e71141: Surface worker-health on the Telescope "Workflows" dashboard. A new `durable.workerHealth` data provider reads `WorkflowEngine.workerHealth()` (queue depth vs. live worker heartbeats), powering two new panels: a **"Starved groups"** stat (groups with work queued and zero live workers — the "alive but not consuming" alert state) and a **"Worker groups"** table (group · queued · live workers · status, starved first). Complements the `/durable` Workers panel for ops who live in Telescope.

## 0.3.0

### Minor Changes

- 613f356: Workflows dashboard "Recent failed runs" table is now time-bounded and shows when each failure happened. The `durable.recentFailures` provider only returns failures updated within a window (default 24h; `durableTelescopeExtension({ recentFailuresWindowMs })` to tune, `0` for all) and includes a compact `updatedAt` stamp per row — so a healthy system shows an empty table instead of surfacing days-old failures as if they were a live incident.

## 0.2.0

### Minor Changes

- 76e9977: Add `durableTelescopeExtension()` — a first-class Telescope extension that adds a native "Workflows" health dashboard. Register it via `TelescopeModule.forRoot({ extensions: [durableTelescopeExtension({ runHref })] })`. It bundles the existing `DurableTelescopeWatcher` plus a `durable.workflows` dashboard (success rate, failed-in-window, current-state gauges for dead/suspended/running/pending, top failing workflows, and a recent-failures table that deep-links each run out to the durable dashboard via `runHref`). Rollups come from the `durable` entries Telescope already captures; current-state gauges read the durable store live via `listRuns`. Requires a `@dudousxd/nestjs-telescope` version that supports the `extensions` option. The standalone `DurableTelescopeWatcher` export is unchanged.
