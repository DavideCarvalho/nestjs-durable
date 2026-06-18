# @dudousxd/nestjs-durable-core

## 0.28.1

### Patch Changes

- b7267da: perf: `getEvent` and `getRunChildren` use targeted store queries instead of fetching and JS-filtering every checkpoint for a run. Adds two **optional** `StateStore` methods (`getLatestCheckpointByName`, `listCheckpointsByNamePrefix`) implemented by all first-party adapters; the engine falls back to the previous `listCheckpoints` scan when a custom store omits them, so this is non-breaking. Cuts per-call rows fetched from O(N) to O(1)/O(k).

## 0.28.0

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

## 0.27.1

### Patch Changes

- a7a81c6: perf: O(N) replay and single-query TypeORM writes — batch-load checkpoints once per execution into a seq→checkpoint map (serving the completed replay prefix from memory with a store fallback for positions written after the snapshot), replacing the O(N²) per-resume `getCheckpoint` round-trips. TypeORM `updateRun` is now a single `UPDATE` and `saveCheckpoint` an `upsert`.

## 0.27.0

### Minor Changes

- 00d5dcf: Re-hydrate the originating context around a LOCAL step body (consume side). The engine gains an optional `rehydrate` hook (`<T>(carrier, fn) => T`) that wraps the in-process local step-handler invocation, passing the run's `context` carrier; the default is a passthrough, so behavior is byte-identical when unset. `DurableModule` wires it automatically when `@dudousxd/nestjs-context` is installed (an accessor is bound): it resolves nestjs-context's module-level `Context` singleton via a guarded dynamic import at module init and runs each local step inside `Context.deserialize(carrier, fn)`, so `Context.userRef()/tenantId()/traceId()` work ambiently inside a `@DurableStep` handler without the consumer wrapping anything. No handler signature change (the context is ambient via AsyncLocalStorage); `@dudousxd/nestjs-context` stays an optional peer (no hard/static import), and re-hydration is best-effort — an empty/undefined carrier just runs the handler normally.

## 0.26.0

### Minor Changes

- e00d037: Optional opaque context carrier dispatched alongside `traceparent`: `WorkflowEngine`/`DurableModule` gain a `context?: () => Record<string, unknown>` option, injected into `RemoteTask` at all dispatch sites and surfaced in the Python SDK (`StepContext.context` / `current_context()`).

## 0.25.1

### Patch Changes

- 26bab70: Keep an awaited child workflow attached to its parent after it finishes, and stop a child node-click from navigating away.

  - **core:** `getRunChildren` now discovers an awaited `ctx.child` from the persisted `signal:child:<id>` checkpoint, not only the live `child:<id>` signal waiter. The waiter is consumed the instant the child settles, so a completed parent (or completed child) used to drop out of the parent→children tree — making an inline child view vanish the moment its work finished. The checkpoint persists across completion, so the edge is now stable for finished runs too.
  - **dashboard:** clicking a child-workflow node (graph) or row (spans) now opens its step detail like any other step, instead of immediately navigating to the child run. Navigating is the dedicated `child ↗` badge's job — so you can inspect a child step (and inline-expand it) without leaving the run.

## 0.25.0

### Minor Changes

- 882dddd: Show an awaited child workflow LIVE in its parent's timeline. `ctx.child` registered the child's signal waiter and suspended but saved no checkpoint, so the parent showed nothing (and no expandable child node) until the child finished. It now writes a `running` placeholder at the child's seq (the same `signal:child:<id>` name the completion overwrites), so the dashboard renders the child node — and can inline-expand it — while it runs. The placeholder is `running` (ignored by replay history, so determinism is untouched) and is overwritten as `completed`/`failed` when the child settles.

## 0.24.0

### Minor Changes

- 4a9de4a: Live per-step observability for remote (polyglot) workflows. A Python `@workflow` runs its `ctx.step`s inline over a single turn that can last minutes, so previously the engine learned of the steps only when the turn ended — the dashboard showed "no steps yet" the whole run, and when they finally landed they had a 0ms duration and no sub-process trail.

  The worker now streams each local step's lifecycle as it happens, over a dedicated point-to-point `<prefix>-step-events` queue (a single engine instance consumes each event and checkpoints it once — no cross-pod duplicate writes):

  - **core**: `WorkflowStepEvent` + `Transport.dispatchStepEvent`/`onStepEvent`; the engine persists a `running` checkpoint when a step's body begins and resolves it to `completed`/`failed` with the step's real wall-clock window and its sub-process/log `events`. The turn's final `recordStep` command now also carries `startedAt`/`finishedAt`/`events` and `applyCommands` honors them, so the idempotent turn-end persist matches the live one (real duration, not 0ms).
  - **transport-bullmq**: implements `dispatchStepEvent`/`onStepEvent` over the `<prefix>-step-events` queue.

  Result: each handler step appears `running` the moment it starts, then `completed`/`failed` with a true duration and its p-processes shown under it — live, not all at once at the end.

## 0.23.0

### Minor Changes

- 00c4f5f: Worker-health observability: surface per-group queue backlog vs. live workers, so "a worker is alive but consuming nothing" stops being silent.

  - **transport-bullmq**: a worker stamps a TTL'd liveness heartbeat (`<prefix>-worker-heartbeat:<group>:<instance>`, refreshed every 10s / 35s TTL) while it's consuming — the key expiring is the signal it died or stalled. Mirrors the Python SDK's heartbeat key, so a mixed-language group reports all its workers together. Adds `groupHealth(group)` (queue depth via `getJobCounts` + live workers via a non-blocking `SCAN`) and `listWorkerGroups()` (discovers groups from the heartbeat keyspace).
  - **core**: `WorkerHeartbeat`/`GroupHealth` types + an optional `Transport.groupHealth`/`listWorkerGroups`. `WorkflowEngine.workerHealth()` aggregates health across the engine's registered groups (so a registered group with backlog and ZERO workers still reports — the alert case) UNION the groups discovered from live heartbeats (so a local-step group surfaces once its workers beat).
  - **dashboard**: a `/workers` API endpoint + a header "Workers" panel — one chip per group showing live-worker count and backlog, turning red on `depth > 0 && liveWorkers === 0`. The Prometheus `/metrics` scrape also emits `durable_group_queue_depth` and `durable_group_live_workers` gauges, so the same signal can drive an alert rule.

## 0.22.1

### Patch Changes

- 74bd7f2: Record local steps that ran on the same turn a remote (polyglot) workflow terminates. The engine only applied a decision's `recordStep` commands on the `continue`/suspend branch — so a workflow that runs straight to completion (or failure) in a single turn, every step inline and never suspending (e.g. a Python `@workflow` whose body is a sequence of `ctx.step` calls), had all its step checkpoints silently dropped. The run showed `completed` with output but **zero recorded steps**, and a parent that awaited it via `ctx.child` then had nothing to expand inline. The `completed` and `failed` branches now apply the final turn's commands before marking the run terminal, so single-turn workflows persist their steps (including the failed one).

## 0.22.0

### Minor Changes

- 8b307f8: feat(step-logger): ergonomic `log.subProcess(name, body)` for auto-timed sub-processes

  The TS `StepLogger` now has the twin of the Python SDK's `sub_process`: wrap a phase in
  `await log.subProcess('export-file', () => upload())` and it records a terminal `ok` with the
  measured `durationMs` on success — or `failed` (with the error message) on throw, then re-throws. The
  handle exposes `sp.phase(label)` and `sp.skip(reason)`, and logs emitted inside the body are tagged
  to the sub-process so the dashboard groups them under it. Returns whatever the body returns. Replaces
  the manual `Date.now()` + `log.sub(name, 'ok', …, { durationMs })` pattern.

## 0.21.0

### Minor Changes

- 7f7598b: feat(engine): execute remote workflow `waitSignal` and `startChild` commands

  The coordinator-driven (polyglot) engine now drives the last two workflow commands a remote worker
  can emit. `ctx.wait_signal(name)` registers a signal waiter (resolved by `engine.signal(name, …)`,
  with a buffered-before-wait signal re-driven safely after the turn suspends), and
  `ctx.start_child(workflow, input)` starts a child run under a deterministic id and awaits it via the
  existing parent-notify rendezvous — a failed child surfaces as a catchable `StepFailed` in the
  parent's replay. Previously both threw "not supported yet". `call` / `recordStep` / `sleep` are
  unchanged.

## 0.20.0

### Minor Changes

- dcc97fd: Make in-flight local steps visible. A local `ctx.step` now announces its body has started — emitting a `step.started` lifecycle event and (by default) persisting a `running` checkpoint — so a long-running step shows up in the dashboard the moment it begins, not only once it completes. Previously a local step was checkpointed only on completion, so an in-progress step was invisible.

  - New checkpoint status `'running'` for a local step whose body is executing in-process. It's a placeholder overwritten by `completed`/`failed`, and never short-circuits replay (only `completed` does), so a crash mid-body simply re-runs the step.
  - New engine option `trackStepStart` (default `true`). The `step.started` event always fires (the live SSE view sees the start regardless); the flag gates only the extra `running` checkpoint write. Set it to `false` on hot paths with many short local steps to halve their checkpoint writes — at the cost of reload-survivable in-flight visibility.

- 63b0d09: Extensible sub-process model: `StepEvent` gains optional `subId` (run identity), `group`, and `phase`
  fields, and `StepLogger` gains `subEvent()` for emitting per-sub-process phase transitions and a
  terminal outcome. The dashboard renders each sub-process as an expandable lifecycle row (phases,
  duration, status, error, owned logs) grouped by run identity. The existing `sub(name, status)` is
  unchanged.

## 0.19.0

### Minor Changes

- ed4a429: Add the polyglot-workflow protocol types: `WorkflowTask`, `HistoryEvent`, `WorkflowCommand`,
  `WorkflowDecision`, and the `WorkflowExecutor` interface. These define the coordinator-driven contract
  by which a workflow authored in another SDK (e.g. the Python `durable-worker`) is advanced by the
  engine one turn at a time — the engine stays the sole owner of the durable state and applies the
  decisions a remote worker's replay produces. Types only in this release (no behaviour change); the
  engine-side remote executor lands next. See docs/plans/2026-06-15-polyglot-workflows-protocol.md.
- 38f1cc6: Drive remote (cross-SDK) workflows: `engine.registerRemote(name, version, { group, executor })`. The
  engine advances such a run by handing its history to the `WorkflowExecutor` (which dispatches a
  `WorkflowTask` to a worker — e.g. the Python `durable-worker`) and applying the returned
  `WorkflowDecision`: it persists recorded local steps, dispatches `call` commands as remote steps, and
  schedules `sleep` timers, then settles or suspends the run. Everything around it — lease, recovery,
  timers, the resume on a step result — is the same machinery as an in-process workflow, so the worker
  never touches the store. `waitSignal`/`startChild` commands are a follow-up (they fail loudly for now).
- 419facb: Carry remote workflows over the transport: `Transport.dispatchWorkflowTask` / `onDecision` (optional),
  implemented by `BullMQTransport` (dispatch a WorkflowTask on `<prefix>-tasks-<group>`, consume decisions
  on `<prefix>-decisions` — the queues the Python `durable-worker`'s `run_redis_workflow_worker` serves).
  New `RemoteWorkflowExecutor` implements `WorkflowExecutor` over a transport (correlates each turn's
  decision by `taskId`), so `engine.registerRemote(name, version, { group, executor })` drives a workflow
  authored in another SDK over Redis/BullMQ. Verified end-to-end live: a Python `WorkflowWorker` replays
  and the TS engine drives it across real Redis.

## 0.18.0

### Minor Changes

- 56eea68: Close the transport on graceful shutdown, not just drain the engine.

  `WorkflowRegistrar.onApplicationShutdown` drained in-flight runs but left the transport open, so a
  deploy left the broker workers consuming and connections to time out. It now closes the transport(s)
  _after_ the drain (so in-flight runs can still dispatch/await their remote steps while draining). Adds
  an optional `close?()` to the `Transport` interface — a no-op for in-process transports; the BullMQ
  transport already implemented it. Remember this only fires if the app calls `app.enableShutdownHooks()`.

## 0.17.1

### Patch Changes

- 2183174: Internal: extract the durable-entity and event-accumulator subsystems out of the engine.

  Carves the `__entity` runner (now `Entities`) and the `__evt_debounce`/`__evt_batch` accumulators (now `EventAccumulators`) into their own modules, leaving the engine methods as thin delegations. Adds a canonical `engine.getRunChildren(runId)` and uses it for both the cancel cascade and the dashboard run-tree, replacing the child-discovery logic that was copy-pasted across the two. Behavior-preserving — no public API change.

## 0.17.0

### Minor Changes

- e149ec6: Live step progress + per-sub-process log grouping, and a dashboard layout fix.

  - **`step.progress` events**: a running step's log lines / sub-process outcomes are now emitted as
    `step.progress` engine events as they happen (not only batched onto `step.completed`). They ride
    the control plane like any lifecycle event, so the dashboard tails a long step line-by-line. The
    dashboard merges each one into the cached run instead of refetching (no store round-trip per line —
    and the store only has the events at completion anyway). `EngineEvent` gains an optional `event`.
  - **`StepEvent.process`**: a log line emitted inside a sub-process can carry that sub-process's name,
    so the step detail panel groups a fan-out step's trail per sub-process instead of one flat list.
  - **Dashboard layout**: the run-detail spans panel no longer collapses the WorkflowGraph to 0px. Its
    height now lives in the grid track (`1fr clamp(...)`); as an `auto` row it sized to the (tall) span
    content's min-content and stole the whole grid.

  The Python worker client (`durable-worker`) gains the matching `StepContext.process(name)`, an
  `on_event` sink on `process_task`/`aprocess_task`, and live `step.progress` publishing from the Redis
  runner — released separately on its own version.

- a0adc71: Dashboard polish: fix-and-replay, run tree, more metrics.

  - **Fix-and-replay**: `engine.retryWithInput(runId, input)` re-runs a dead/failed run with a corrected input as a fresh linked run (the original stays inspectable). The dashboard run detail gets a **"Fix & replay"** button (edit the input JSON, re-run) for dead/failed runs.
  - **Run tree**: the run detail now lists the run's **children** (`ctx.child` / `ctx.startChild`), clickable to navigate the parent→children tree.
  - **Metrics**: `/metrics` adds a `durable_running_runs` gauge (alongside the `durable_pending_runs` backlog + `durable_dead_runs` DLQ-size gauges).

## 0.16.0

### Minor Changes

- dc5e0f6: Exactly-once transactional steps — `ctx.transaction(name, (tx) => ...)`.

  Runs your DB work and the step's checkpoint in **one** store transaction, so the business write and the "done" marker commit atomically — a crash can never leave the write done-but-not-checkpointed (which a plain `ctx.step` re-runs on recovery). `tx` is the store-native transaction handle (a TypeORM/MikroORM `EntityManager`, a Prisma tx client, or a Drizzle tx); do your writes on it. Needs a SQL store (all bundled SQL adapters implement the new optional `StateStore.transaction`); errors on a store without it. This is the DBOS-style exactly-once guarantee for same-database work.

- 64bfcbe: Durable keyed **entities** (virtual objects) — a per-key actor whose handlers run **serialized over durable state**, exactly once. Generalizes singleton; ideal for counters, carts, rate-limiters, aggregators.

  - **Core**: `engine.registerEntity(name, { initialState, handlers })`; `engine.signalEntity(name, key, op, arg)` (fire) / `engine.getEntityState(name, key)` (read); from a workflow, `ctx.callEntity(name, key, op, arg)` (call + await result) and `ctx.signalEntity(...)`. Each key is one long-lived run processing ops in order.
  - **NestJS**: `@Entity({ name })` on an `@Injectable()` class with `@On(op)` methods over its fields (state); `EntityService.signal/getState`. A fresh instance per key is the initial state; methods are re-attached after replay.

  (Per-key history compaction via continueAsNew for very-hot keys is a follow-up.)

- 8ba981d: Signal-with-start (durable entities), cancel→child propagation, and low-latency dispatch.

  - **Reliable signals + `signalWithStart`**: a signal sent with no waiter is now **buffered** (FIFO per token) and delivered to the next `waitForSignal` — signals are never lost to timing. `engine.signalWithStart(workflow, input, runId, { token, payload })` / `workflowService.signalWithStart(...)` ensures a run exists then delivers a signal, race-free — the canonical **durable-entity / accumulator** pattern (one long-lived run per key fed events by many calls). New `StateStore.bufferSignal` / `takeBufferedSignal` (custom stores must add them; all bundled adapters do).
  - **Cancellation cascades to children**: `engine.cancel(parent)` now cancels the runs it started via `ctx.child` / `ctx.startChild` (recursively), and no longer clobbers an already-finished run.
  - **Low-latency cross-pod dispatch**: a run enqueued on one instance (e.g. an API pod) nudges worker instances over the control plane (`engine.onEnqueued`) to pick it up at once instead of on the next poll. The dashboard `/metrics` adds `durable_pending_runs` (dispatch backlog) + `durable_dead_runs` (DLQ size) gauges.

- fb9746a: Event **debounce** and **batch** for `onEvent` triggers — coalesce a burst of events into fewer runs (Inngest-style).

  - `@Workflow({ onEvent: ['x'], debounce: '30s' })` — start one run with the LAST payload once events have been quiet for the window (resets on each event).
  - `@Workflow({ onEvent: ['x'], batch: { maxSize: 100, within: '10s' } })` — start one run with all payloads (`{ events: [...] }`) once `maxSize` is reached or `within` elapses from the first event.
  - Engine: `register(..., { eventBatch })`. Built on the new signal buffering + `signalWithStart` + `continueAsNew` — a per-target accumulator coalesces and then starts the target.

  (Queue priority from the same roadmap item is deferred: the poll-based flow-control queue model makes strict priority awkward, and soft priority adds little.)

## 0.15.0

### Minor Changes

- 36eb9d7: Crash recovery now **re-enqueues** orphaned runs instead of resuming them inline. Previously `recoverIncomplete()` (run on worker boot and every poll tick) resumed each crashed run synchronously — so a worker booting while a run had a long inline `ctx.step` (e.g. a big export rebuilt from scratch) would block on that step and never become ready (a deploy could time out). Now recovery counts the attempt (still dead-letters a poison pill past `maxRecoveryAttempts`), then sets the run `pending` and dispatches it — a worker re-runs it asynchronously, replaying its checkpoints. Boot and poll ticks return immediately. `recoverIncomplete()` now returns the runs as `{ status: 'pending' }`.

## 0.14.0

### Minor Changes

- c99508d: Self-healing recovery + non-blocking dashboard actions.

  - **Lease renewal**: while a run executes, the engine renews its recovery lease (every `leaseMs/2`), so a live worker keeps a long run while a **crashed** worker's lease still expires. `execute` now holds the lease for the whole run on every entry path (sweep, signal, remote result, dashboard), so a run is never double-executed. New `StateStore.renewRunLock(runId, owner, leaseUntilMs)` — **custom stores must add it**.
  - **Periodic orphan recovery**: the NestJS `TimerPoller` now calls `engine.recoverIncomplete()` each tick, so a run orphaned by a crashed worker self-heals within ~`leaseMs` instead of only on the next boot.
  - **Non-blocking control actions** (fixes the `/durable` retry/cancel request hanging): `retry` now re-enqueues via the new `engine.requeue(runId)` (sets `pending` + dispatches) and `cancel({ compensate })` runs the undo in the background — neither replays the workflow inline in the HTTP request anymore. A worker does the work.

## 0.13.0

### Minor Changes

- a5fd901: **Breaking (0.x minor): `start` now dispatches to a worker instead of running the workflow inline.**

  Previously `engine.start` / `WorkflowService.start` executed the workflow body inline and returned the terminal `RunResult`. Now `start` only **enqueues**: it creates the run as a new `'pending'` status, hands it to a `RunDispatcher`, and returns `{ runId, status: 'pending' }` immediately — the body runs on a worker, so the caller (e.g. an HTTP handler) never blocks on workflow logic.

  **Migration**

  - To await the outcome, use the new `engine.waitForRun(runId)` / `workflowService.waitForRun(runId)` — resolves once the run settles (terminal or suspended). `const { runId } = await start(...); const result = await waitForRun(runId)`.
  - **Default behavior is unchanged for single-process apps**: the default in-process dispatcher executes the run on the same instance (asynchronously), so runs still execute with no extra setup.
  - **Offload to workers**: pass a no-op `runDispatcher` on API/dashboard instances (or set NestJS `worker: false`) so they enqueue-only; worker instances poll `engine.runPending()` (the NestJS `TimerPoller` now does this each tick) to pick up `pending` runs. A broker-backed dispatcher can enqueue to a queue whose workers call `engine.runOne(runId)`.

  New: `RunStatus` gains `'pending'`; engine gains `runOne`, `runPending`, `waitForRun`; `WorkflowEngineDeps.runDispatcher`. The testing harness gains `createTestEngine().run(...)` (start + wait) and the dashboard shows the `pending` state. `StateStore` gains `listPendingRuns(limit)` (oldest-first / FIFO) — **custom store implementations must add it** (all bundled adapters do).

- a5fd901: Event-triggered workflows: a workflow can now **start** on a published event, not just wait for one.

  - **Core**: `engine.register(name, version, fn, { onEvent: ['user.registered'] })` — `publishEvent(name, payload, { id })` now starts a fresh run of every subscribed workflow (payload becomes the input) in addition to resuming `waitForEvent` waiters. Idempotent by `evt:<id>:<workflow>`; the return count includes both resumed and started runs.
  - **NestJS**: `@Workflow({ onEvent: [...] })` **or** a dedicated `@OnEvent('a', 'b')` class decorator (listen to several events; both forms merge). `workflowService.publishEvent(name, payload, { id })` gained the dedup id.

- a5fd901: Input validation at workflow start. The engine now rejects a bad payload **before any run is created**, so invalid input never produces a dead/failed run.

  - **Core** (validator-agnostic): `engine.register(name, version, fn, { validateInput })` — a `(input) => void | Promise<void>` that throws to reject.
  - **NestJS** (class-validator, the controller default): `@Workflow({ inputSchema: CheckoutInput })` validates with the same `plainToInstance` + `validate` NestJS runs in controllers. `class-validator` + `class-transformer` are lazy-required optional peers. For zod/yup/etc. pass `@Workflow({ validateInput })` instead (it wins over `inputSchema`).

- a5fd901: Typed search attributes — query runs by structured data, not just exact-match tag labels.

  - **Start**: `start(wf, input, id, { searchAttributes: { amount: 200, tier: 'pro' } })` stamps typed, queryable data on a run.
  - **Query**: `RunQuery.attributes` takes `{ key, op, value }` predicates ANDed together, with `eq/ne/gt/gte/lt/lte` — so range queries like `amount >= 200 AND tier = 'pro'` work. Applied in-process after the coarse workflow/status/tag filters, so it's portable across all store adapters (typeorm/prisma/mikro-orm/drizzle gain a `searchAttributes` JSON column).
  - **Dashboard**: an attribute filter box (`amount:gte:200, tier:eq:pro`), attribute pills on the run detail, and bulk retry/cancel honoring the same predicates. API: `GET /runs?attr=key:op:value` (repeatable).

- a5fd901: Step interceptors — onion middleware around the real execution of every local `ctx.step` (timing, logging, tracing, error enrichment, context propagation). They fire **only when a step actually executes, never on replay**, so timing/metrics reflect true work.

  - **Core**: `engine.use((invocation, next) => ...)` — `invocation` carries `{ runId, workflow, stepName, seq, attempt }`; `next()` runs the step body / next interceptor and returns its result. First registered is outermost. Returns an unsubscribe.
  - **NestJS**: `@StepInterceptor()` on an `@Injectable()` class implementing `DurableStepInterceptor` (so it can inject loggers/tracers). Discovered and wired on boot.

## 0.12.0

### Minor Changes

- f2260da: feat: named events — ctx.waitForEvent + engine.publishEvent

  Name-based pub/sub on top of the signal machinery, for choreography beyond point-to-point signals. A
  run suspends on `ctx.waitForEvent('payment.settled', { match: { orderId }, timeoutMs })` and resumes
  with the payload; `engine.publishEvent(name, payload)` (also `WorkflowService.publishEvent`) fans out
  to every waiting run whose `match` the payload satisfies, returning how many it resumed. The match is
  encoded in the waiter token, so the only store change is a new `listSignalWaiters(prefix)` method
  (implemented across in-memory, TypeORM, MikroORM, Prisma, Drizzle) — no new schema.

## 0.11.0

### Minor Changes

- c3398be: feat: executionTimeout — cap a run's wall-clock lifetime

  `@Workflow({ executionTimeout: '2h' })` (or ms) moves a run to `cancelled` (`execution_timeout`) once
  it outlives the budget — a backstop for runs that get stuck or loop forever. Enforced by a new
  `engine.sweepTimeouts(now)` the timer poller calls each tick (over the existing workflow+status query;
  no new schema). The terminal `cancelled` state means a late step result can't resurrect it.

- 8b87a16: feat(scheduler): pause + overlap policy

  `ScheduledWorkflow` gains two controls:

  - **`paused`** — temporarily stop firing a schedule (kept registered).
  - **`overlap: 'skip'`** (fixed-interval) — skip a window while the previous window's run is still
    `running`/`suspended`, so a slow run can't pile up overlapping executions (default `'allow'`).

  Also adds a public `engine.getRun(runId)` pass-through.

## 0.10.0

### Minor Changes

- 12c91ff: feat: Prometheus metrics

  `collectMetrics(engine)` subscribes to the engine's lifecycle events and accumulates dependency-free
  counters — runs + steps by outcome, per-workflow run counts, step-duration sum/count. Call
  `.prometheus()` for the text exposition or `.snapshot()` for raw numbers. The dashboard wires it
  automatically and serves it at `GET <apiBasePath>/metrics` for a scrape.

- 4fb5f90: feat: CodecStateStore — encrypt / compress / redact payloads at rest

  A `StateStore` decorator that runs run/step **payloads** (input + output) through a `PayloadCodec`
  (encode on write, decode on read), so they're never stored in the clear — for at-rest encryption,
  compression, or PII redaction. Adapter-agnostic (`new CodecStateStore(innerStore, codec)`).
  Searchable metadata (id, status, workflow, tags, timestamps) and the structured `error` are left
  untouched so the dashboard, queries, and recovery keep working.

- bc4539d: feat: singleton — serialize runs by key (durable FIFO mutex)

  `@Workflow({ singleton: { key: (input) => `base:${input.baseId}` } })` runs at most one run per key
  at a time (e.g. one pipeline per base). Same-key runs queue — suspended, admitted in creation order
  as slots free — instead of running concurrently. `limit` (default 1) raises the concurrency. Race-free
  and FIFO on a consistent store: admission is the same `(createdAt, id)` view for every engine instance,
  implemented over the existing tag+status query (no new schema). Also exposed as
  `engine.register(name, version, fn, { singleton })`.

- b72c20f: feat: ctx.sleepUntil + ctx.continueAsNew

  - **`ctx.sleepUntil(date | epochMs)`** — durable sleep to an absolute deadline (e.g. "resume at
    midnight"), the absolute-time counterpart of `ctx.sleep(duration)`. Replay-stable.
  - **`ctx.continueAsNew(input?)`** — end the current run and hand off to a fresh execution of the same
    workflow with a clean history, for long-running / looping workflows that would otherwise accumulate
    unbounded checkpoints. The next run gets id `<runId>~N`; the handoff is idempotent by that id.

## 0.9.0

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

## 0.8.1

### Patch Changes

- 6979d60: fix: list runs newest-first

  `store.listRuns` now orders by `createdAt DESC` (was `ASC`) across every adapter (in-memory,
  TypeORM, MikroORM, Prisma, Drizzle), so the dashboard shows the most recent run on top instead of
  buried at the bottom.

## 0.8.0

### Minor Changes

- 2addfd2: feat: pass workflow **classes** instead of name strings, and a fire-and-forget `ctx.startChild`

  **Workflow class refs.** Anywhere you named a workflow by string, you can now pass its class for a
  same-runtime call — refactor-safe and typed — while strings stay for cross-runtime (e.g. a Python
  workflow):

  - `ctx.child(ShippingWorkflow, input)` — input is type-checked and the result is inferred from the
    child's `run` (no manual type parameter).
  - `engine.start(CheckoutWorkflow, input)` / `WorkflowService.start(CheckoutWorkflow, input)`.
  - `@Workflow({ deadLetterWorkflow: PipelineDlqWorkflow })` and the module-level `deadLetterWorkflow`.

  The `@Workflow` decorator stamps the registered name on the class; `workflowName(ref)` (exported)
  resolves a `WorkflowRef` (`string | WorkflowClass`) back to its name. New exported types:
  `WorkflowClass`, `WorkflowRef`, `WorkflowInputOf`, `WorkflowOutputOf`, and `WORKFLOW_NAME_KEY`.

  **`ctx.startChild`.** A fire-and-forget counterpart to `ctx.child`: dispatches a child once
  (checkpointed, replay-safe) and returns its run id immediately instead of suspending — for side work
  the parent doesn't wait on, or scatter-gather (start many, then `ctx.child` each by the same id to
  join; the start is idempotent by id, so each child runs exactly once).

## 0.7.0

### Minor Changes

- e9799ca: feat: dead-letter handler — `engine.onDead` + `deadLetterWorkflow`

  Dead-lettering is no longer only "park the run in `dead`". `engine.onDead((run) => …)` fires when a
  run is moved to `dead` (exceeded `maxRecoveryAttempts`), so a DLQ handler can alert, push to a real
  queue, or compensate. The NestJS module adds a `deadLetterWorkflow` option that routes a dead run to
  a designated workflow with `{ deadRunId, workflow, input, error }` (idempotent by a `dlq:<runId>` id).
  Omitting both keeps the prior behaviour (the run stays parked, inspectable + retriable).

## 0.6.0

### Minor Changes

- 0900830: feat: compensating cancellation — `engine.cancel(runId, { compensate: true })`

  Cancelling a run can now undo its saga first: the suspended run is resumed with a cancellation
  pending, so replay re-registers the saga and its completed steps' compensations run in reverse
  (visible as `compensate:<step>` events) before the run is marked cancelled. Plain `cancel()` is
  unchanged (immediate, no undo). The dashboard's cancel accepts `?compensate=true`
  (`durableClient.cancel(id, { compensate: true })`), and the codegen client exposes the flag.

- df6524f: feat: cron + timezone schedules

  `ScheduledWorkflow` now accepts a `cron` expression with an IANA `timezone` (DST-aware) as an
  alternative to the fixed-interval `everyMs`. The run id is keyed on the most recent fire time, so
  polling repeatedly within an interval — or racing instances on the same tick — starts each fire
  exactly once (idempotent). The NestJS module gains a `schedules` option; the timer poller fires them
  each tick on **worker** instances only. Cron evaluation uses the optional `cron-parser` peer
  dependency, so the core stays dependency-free for users who don't schedule by cron.

- 9f9767e: feat: `ctx.patched(id)` — guard in-place workflow changes

  Migrate a workflow without registering a new version: wrap the changed code in
  `if (await ctx.patched('my-change')) { …new… } else { …old… }`. A fresh run records a `patch:<id>`
  marker and takes the new branch; a run already recorded under the old code keeps the old branch,
  because the marker is **position-transparent** for it (it rolls the logical position back when the
  recorded history has a real step where the marker would sit) — so guarding code never shifts an
  in-flight run's checkpoints and can't corrupt replay. Remove the guard once old runs have drained.

- 3f79533: feat: dead-letter queue — `maxRecoveryAttempts` + `dead` run status

  Crash recovery now counts attempts per run (`WorkflowRun.recoveryAttempts`); once a still-`running`
  run exceeds the engine/module `maxRecoveryAttempts`, it's moved to the new terminal **`dead`** status
  instead of being retried forever — so a poison pill that crashes the process every boot becomes an
  inspectable dead-letter entry, not a crash loop. The new column is persisted by all four store
  adapters (TypeORM auto-schema self-heals it; Prisma/Drizzle/MikroORM schemas updated), and `dead` is
  added to the dashboard/codegen status unions. Omit `maxRecoveryAttempts` for the prior unlimited-retry behaviour.

- fb8a12b: feat: retry with backoff on the durable remote path

  A durable `ctx.call` (no `timeoutMs`) now re-dispatches a **failed** remote step up to `retries`,
  spacing attempts by the configured `backoff`/`backoffMs` — the retry deadline is stamped on the
  failed checkpoint as `wakeAt` (clock-space, persisted), so it's stable across replays and survives a
  crash. A worker can opt out per-failure by throwing an error with `retryable: false` (now carried
  through the wire by the step runner, alongside `code`), which the engine treats as a final verdict.

- 9c4a3cf: feat: durable webhooks (`ctx.webhook()`)

  A first-class, replay-safe "expose a callback URL and wait for it" primitive. `ctx.webhook()` mints
  a deterministic token (`wh:<runId>:<seq>`) and — when the engine has a `webhookUrl` builder — a
  public `url` to hand a third party inside a step; `await handle.wait()` then suspends with zero
  compute until the callback arrives. The dashboard exposes `POST webhooks/:token` (turning the inbound
  POST into `engine.signal`), the NestJS module gains a `webhookUrl` option, and the codegen extension
  emits the `deliverWebhook` (and the previously-missing `continue`) route into the typed client.

- fc9764c: feat: flow control — durable queues for remote steps

  `engine.registerQueue({ name, concurrency, rateLimit })` (or the NestJS module's `queues` option)
  caps how much work `ctx.call(step, input, { queue })` admits at once — a concurrency limit and/or a
  fixed-window rate limit. A call that can't be admitted does **not** dispatch: the run re-suspends
  with the queue's retry time and the timer poller re-tries admission later, so the limit is durable
  (survives crashes) without holding the run in memory. Accounting is per engine instance (the DBOS
  `workerConcurrency` tier); global cross-instance limits remain a follow-up needing a durable counter.

- 7c50198: feat: multiple transports with failover + per-step selection

  The engine now accepts an ordered `transports` pool (`[{ id, transport }]`): it dispatches on the
  first and **fails over to the next on a dispatch error**, and a step can pin one with
  `ctx.call(step, input, { transport: 'sqs' })`. The chosen transport id is stamped on the
  `RemoteTask` (`task.transport`) so a worker that consumes several transports replies on the matching
  one — failover stays symmetric without the worker ever choosing a transport. Results/heartbeats are
  consumed from every transport in the pool. `transport` (single) remains as shorthand for a one-entry
  pool; the NestJS module exposes `transports`. Cross-language note: run one worker/runner per broker
  and the matching one handles each failover hop and replies on its own broker — no worker change
  needed; `task.transport` is there for processes that multiplex brokers.

- 9e36ac0: feat: saga compensation retry + visibility, and a dashboard query index

  - **Compensation retry + visibility** — each saga undo is now retried up to `compensationRetries`
    (engine/module option, default 1) and emits a `compensate:<step>` step event for its outcome, so a
    stranded undo shows up in the dashboard/telescope instead of being silently swallowed. A
    permanently-failing compensation is still skipped so it can't mask the original failure.
  - **TypeORM auto-schema index** — adds `(workflow, status)` alongside the existing `(status, wakeAt)`
    index, so the dashboard's `listRuns` filter hits an index.

- f915e2c: feat: synchronous queries & validated updates

  Two Temporal-style primitives adapted to the suspend/checkpoint model:

  - **Query** — `ctx.setEvent(key, value)` publishes a named, replay-safe value; `engine.getEvent(runId, key)`
    reads the latest value of a live (or finished) run with no side effect. Exposed as
    `GET runs/:id/events/:key`.
  - **Update** — `ctx.onUpdate(name)` is a run-scoped update point; `engine.update(runId, name, arg)`
    delivers to it, gated by a validator registered with `engine.registerUpdateValidator(workflow, name, fn)`
    that can **reject before the run is touched** (`{ accepted: false, reason }`). Exposed as
    `POST runs/:id/updates/:name`. The codegen extension emits both routes into the typed client.

- 6836ace: refactor!: separate the control plane from the Transport

  `publishControl`/`onControl` are no longer part of `Transport`; they form a dedicated `ControlPlane`
  interface, and the engine takes a separate `controlPlane` dependency. This decouples cross-instance
  broadcast (lifecycle events + cancellation) from the point-to-point task transport, so you can run a
  dedicated control plane (e.g. Redis pub/sub) independent of how steps are dispatched. Broadcast-capable
  transports (event-emitter, BullMQ) implement `ControlPlane` too and can be passed as both; the NestJS
  module auto-wires the transport as the control plane when it qualifies, or accepts an explicit
  `controlPlane` option.

- 6b36ffa: feat: propagate W3C traceparent to workers (distributed tracing)

  The engine now stamps a `traceparent` on every dispatched `RemoteTask` from an optional
  `traceparent` provider, so a worker (including the Python SDK) can continue the distributed trace
  instead of starting a detached one. Core stays OTel-free: the otel package exports `otelTraceparent()`
  (reads the active span via the registered W3C propagator) to wire in —
  `new WorkflowEngine({ traceparent: () => otelTraceparent() })` — and the NestJS module exposes a
  `traceparent` option. The wire field already existed; this populates it.

## 0.5.0

### Minor Changes

- **Transport control plane** — a broadcast pub/sub across all engine instances, unlocking the cross-pod features from the durability audit:

  - `Transport.publishControl(msg)` / `onControl(handler)` + a `ControlMessage` type. In-process transports (in-memory, event-emitter) broadcast locally; **BullMQ broadcasts over Redis pub/sub**. Optional — the engine degrades to local-only when a transport doesn't implement it.
  - **Cross-pod live-tail**: the engine now broadcasts lifecycle events, so a dashboard-only pod (`worker: false`) sees events from a run executing on a worker pod. The dashboard exposes `@Sse('runs/:id/stream')` and `durableClient.streamRun(id, onEvent)` — live updates without polling.
  - **Cooperative cancellation**: `engine.cancel(runId)` broadcasts the cancel; `engine.onCancel(fn)` lets a worker bridge abort in-flight work instead of finishing it just to have the result discarded. Events are deduped by originating `instanceId` so a broker echo doesn't double-deliver.

## 0.4.0

### Minor Changes

- Durability hardening (audit follow-up):
  - **Non-determinism detection**: on resume, a step whose name no longer matches the checkpoint recorded at that logical position throws `NonDeterminismError` instead of silently replaying the wrong checkpoint into the wrong step (the classic way a changed-under-flight workflow corrupts a run).
  - **Deterministic sources**: `ctx.now()`, `ctx.random()`, `ctx.uuid()` — checkpointed once and replayed verbatim, so workflows stop being corrupted by raw `Date.now()`/`Math.random()`/`randomUUID()`.
  - **Retry backoff**: `StepOptions` `backoff: 'fixed' | 'exp'` + `backoffMs`/`backoffMaxMs`/`jitter` is now actually applied between local-step retries (it was declared but ignored).
  - **Cancellation safety**: a cancelled/completed run is no longer re-executed by a late worker result or a duplicate `resume()`.
  - **testing**: `assertReplayable(register, history)` replays a recorded run's history against the current workflow code and throws on divergence — a CI guard that catches non-determinism before deploy.
  - **otel**: failed steps now emit a span (with error status), not just completed ones.

## 0.3.1

### Patch Changes

- Hardening from review:
  - TypeORM auto-schema now reads the live columns (`information_schema` / `PRAGMA`) and adds only the missing ones, instead of ALTER-and-swallow — a real ALTER failure now surfaces rather than being hidden as a presumed "column already exists".
  - Breakpoint detection keys off the checkpoint's `breakpoint` name (the explicit marker) rather than the incidentally-reused `signal` kind, so `engine.continue` can't be confused by other pending steps.

## 0.3.0

### Minor Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

## 0.2.0

### Minor Changes

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
