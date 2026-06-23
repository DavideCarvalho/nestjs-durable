# @dudousxd/nestjs-durable

## 0.19.0

### Minor Changes

- 256b8c3: Add a **thin Node/NestJS worker** — a control-plane-less worker (the Node analog of the Python `durable-worker`), so a plain Node/NestJS service can be a pure worker with no store, no engine, no recovery, and no dashboard. The single control-plane engine remains the sole owner of state; N thin workers (Python and now Node) just consume tasks → run handlers / replay workflow bodies → return `StepResult`/`WorkflowDecision` over BullMQ.

  New package `@dudousxd/durable-worker`:

  - `WorkflowContext` — `implements WorkflowCtx`, so a `@Workflow` body written against the engine's authoring API runs unchanged on the thin worker (history → commands replay). Wire-expressible ops (`step`, `call`, `sleep`, `waitForSignal`, `child`, `all`, `now/random/uuid`, plus a `gather` extension) are supported; ops needing engine/store features (`transaction`, `callEntity`, `webhook`, `setEvent`, `onUpdate`, `patched`, `task`, `continueAsNew`, `sleepUntil`, `waitForEvent`, fire-and-forget `startChild`) throw `UnsupportedOnThinWorker`.
  - `WorkflowWorker.processTask` / `StepWorker.processTask` — pure, transport-free decision/result producers.
  - A BullMQ runner that consumes the engine's task queues and returns decisions/results (queue names match `@dudousxd/nestjs-durable-transport-bullmq` exactly).

  `@dudousxd/nestjs-durable` gains `DurableWorkerModule.forRoot({ connection, groups })`: discovers `@Workflow`/`@DurableStep` providers and runs them on the thin worker runtime + BullMQ runner — a NestJS worker process with no `WorkflowEngine`/store bound. A conformance test proves the same `@Workflow` produces identical output and ordered `(seq, name, kind)` on the engine and the thin worker.

## 0.18.1

### Patch Changes

- 1d76da7: Migrate all internal consumers (engine factory, registrars, timer poller, dashboard service, telescope data providers) to the canonical capability tokens, and flip the dual-bind so the canonical token (`@dudousxd/nestjs-durable:state-store`/`:transport`/`:options`) is the real provider while the legacy `nestjs-durable:*` tokens become `useExisting` back-compat aliases. The legacy tokens are now `@deprecated` but still resolve to the same instances — fully non-breaking.

## 0.18.0

### Minor Changes

- def217f: Add canonical, cross-lib-discoverable aliases for the durable DI tokens — `STATE_STORE_CANONICAL`, `TRANSPORT_CANONICAL`, `DURABLE_OPTIONS_CANONICAL` (`@dudousxd/nestjs-durable:state-store` / `:transport` / `:options`, identical to `capability('durable', …)`). `DurableModule` dual-binds them as `useExisting` aliases of the existing tokens, so an external library can resolve durable's store/transport/options by the canonical capability name without importing durable internals. Fully additive and non-breaking: the legacy `nestjs-durable:*` tokens are unchanged and keep working.

## 0.17.0

### Minor Changes

- a9b0b2e: Pluggable admission backend + Redis-backed global flow control.

  The remote-step flow-control gate (`ctx.call(step, input, { queue })`) is now driven by a pluggable
  `AdmissionBackend` instead of an in-process-only controller:

  - **core** — new `AdmissionBackend` interface; the default `InMemoryAdmissionBackend` preserves the
    existing per-instance behaviour. Inject a custom backend via `new WorkflowEngine({ admission })`.
    The admit/release path is async, and an optional `onFreed` capability lets a freed slot wake this
    instance's blocked runs early instead of waiting for their retry tick.
  - **@dudousxd/nestjs-durable-admission-redis** (new) — `RedisAdmissionBackend` makes `concurrency`,
    `rateLimit`, priority **and** `fairness: 'key'` ordering GLOBAL across engine replicas, enforced by
    one atomic Lua script:

    - **Concurrency** via slot→instance ownership: a slot is reclaimed only when its owner's liveness
      heartbeat lapses, so a live pod holds it for the full step duration (no time-lease false purge)
      while a crashed pod's slots free within `instanceTtlMs`.
    - **Rate limit** via a fixed-window counter.
    - **Ordering** by priority desc → fairness round-robin by `key` → arrival order, with abandoned
      waiters pruned so a cancelled run can't deadlock the rest as a phantom best-waiter.

    The arrival tiebreak direction is configurable per queue via `QueueConfig.order: 'fifo' | 'lifo'`
    (default `fifo`) — `lifo` admits the most recent arrival first (a stack). Honored by both the
    in-process and Redis backends; orthogonal to priority and fairness.

    - **Early wake** by publishing a freed-slot signal on `release` that the engine subscribes to.

  - **nestjs** — `DurableModule.forRoot({ admission })` forwards the backend to the engine.

## 0.16.0

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

## 0.15.0

### Minor Changes

- 00d5dcf: Auto-feed the workflow context carrier from `@dudousxd/nestjs-context`. When the optional peer is installed (its accessor bound to the shared `CONTEXT_ACCESSOR` symbol) and the app passes no `context` option, `DurableModule` now defaults the engine's `context` reader to build `{ traceId, tenantId, userRef }` from the request-scoped accessor — so a workflow dispatched within a request automatically carries the originating context across process boundaries. The accessor is resolved structurally (no hard import; `@dudousxd/nestjs-context` is an optional peer dependency). An app-provided `context` option still wins, and with no accessor the carrier stays omitted (unchanged behavior). Exposes the `CONTEXT_ACCESSOR` token and a structural `ContextAccessor` interface.
- 00d5dcf: Re-hydrate the originating context around a LOCAL step body (consume side). The engine gains an optional `rehydrate` hook (`<T>(carrier, fn) => T`) that wraps the in-process local step-handler invocation, passing the run's `context` carrier; the default is a passthrough, so behavior is byte-identical when unset. `DurableModule` wires it automatically when `@dudousxd/nestjs-context` is installed (an accessor is bound): it resolves nestjs-context's module-level `Context` singleton via a guarded dynamic import at module init and runs each local step inside `Context.deserialize(carrier, fn)`, so `Context.userRef()/tenantId()/traceId()` work ambiently inside a `@DurableStep` handler without the consumer wrapping anything. No handler signature change (the context is ambient via AsyncLocalStorage); `@dudousxd/nestjs-context` stays an optional peer (no hard/static import), and re-hydration is best-effort — an empty/undefined carrier just runs the handler normally.

## 0.14.0

### Minor Changes

- e00d037: Optional opaque context carrier dispatched alongside `traceparent`: `WorkflowEngine`/`DurableModule` gain a `context?: () => Record<string, unknown>` option, injected into `RemoteTask` at all dispatch sites and surfaced in the Python SDK (`StepContext.context` / `current_context()`).

## 0.13.0

### Minor Changes

- 56eea68: Close the transport on graceful shutdown, not just drain the engine.

  `WorkflowRegistrar.onApplicationShutdown` drained in-flight runs but left the transport open, so a
  deploy left the broker workers consuming and connections to time out. It now closes the transport(s)
  _after_ the drain (so in-flight runs can still dispatch/await their remote steps while draining). Adds
  an optional `close?()` to the `Transport` interface — a no-op for in-process transports; the BullMQ
  transport already implemented it. Remember this only fires if the app calls `app.enableShutdownHooks()`.

## 0.12.0

### Minor Changes

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

## 0.11.0

### Minor Changes

- c99508d: Self-healing recovery + non-blocking dashboard actions.

  - **Lease renewal**: while a run executes, the engine renews its recovery lease (every `leaseMs/2`), so a live worker keeps a long run while a **crashed** worker's lease still expires. `execute` now holds the lease for the whole run on every entry path (sweep, signal, remote result, dashboard), so a run is never double-executed. New `StateStore.renewRunLock(runId, owner, leaseUntilMs)` — **custom stores must add it**.
  - **Periodic orphan recovery**: the NestJS `TimerPoller` now calls `engine.recoverIncomplete()` each tick, so a run orphaned by a crashed worker self-heals within ~`leaseMs` instead of only on the next boot.
  - **Non-blocking control actions** (fixes the `/durable` retry/cancel request hanging): `retry` now re-enqueues via the new `engine.requeue(runId)` (sets `pending` + dispatches) and `cancel({ compensate })` runs the undo in the background — neither replays the workflow inline in the HTTP request anymore. A worker does the work.

## 0.10.0

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

## 0.9.0

### Minor Changes

- f2260da: feat: named events — ctx.waitForEvent + engine.publishEvent

  Name-based pub/sub on top of the signal machinery, for choreography beyond point-to-point signals. A
  run suspends on `ctx.waitForEvent('payment.settled', { match: { orderId }, timeoutMs })` and resumes
  with the payload; `engine.publishEvent(name, payload)` (also `WorkflowService.publishEvent`) fans out
  to every waiting run whose `match` the payload satisfies, returning how many it resumed. The match is
  encoded in the waiter token, so the only store change is a new `listSignalWaiters(prefix)` method
  (implemented across in-memory, TypeORM, MikroORM, Prisma, Drizzle) — no new schema.

## 0.8.0

### Minor Changes

- c3398be: feat: executionTimeout — cap a run's wall-clock lifetime

  `@Workflow({ executionTimeout: '2h' })` (or ms) moves a run to `cancelled` (`execution_timeout`) once
  it outlives the budget — a backstop for runs that get stuck or loop forever. Enforced by a new
  `engine.sweepTimeouts(now)` the timer poller calls each tick (over the existing workflow+status query;
  no new schema). The terminal `cancelled` state means a late step result can't resurrect it.

## 0.7.0

### Minor Changes

- bc4539d: feat: singleton — serialize runs by key (durable FIFO mutex)

  `@Workflow({ singleton: { key: (input) => `base:${input.baseId}` } })` runs at most one run per key
  at a time (e.g. one pipeline per base). Same-key runs queue — suspended, admitted in creation order
  as slots free — instead of running concurrently. `limit` (default 1) raises the concurrency. Race-free
  and FIFO on a consistent store: admission is the same `(createdAt, id)` view for every engine instance,
  implemented over the existing tag+status query (no new schema). Also exposed as
  `engine.register(name, version, fn, { singleton })`.

## 0.6.0

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

## 0.5.0

### Minor Changes

- 2addfd2: feat: per-workflow dead-letter handlers (`@DeadLetter()` + `@Workflow({ deadLetterWorkflow })`)

  Dead-lettering is now per-workflow, not just a single global module option. A dead run's handler is
  resolved in this order:

  1. an inline **`@DeadLetter()`** method on the workflow class — co-located, shares the class's
     injected deps, runs as a durable workflow auto-registered as `<name>.dlq`, and receives a typed
     `DeadLetter<TInput>` payload;
  2. the workflow's **`@Workflow({ deadLetterWorkflow: 'other-wf' })`** reference to another registered
     workflow;
  3. the module-level **`deadLetterWorkflow`** default (unchanged), now a fallback for workflows that
     declare neither.

  A workflow declaring both an inline `@DeadLetter()` and a `deadLetterWorkflow` reference fails fast at
  boot (ambiguous config). DLQ routing now lives in the `WorkflowRegistrar` (which owns the `@Workflow`
  metadata) instead of the module factory. New public exports: the `DeadLetter()` decorator and the
  `DeadLetter<TInput>` payload type.

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

## 0.4.0

### Minor Changes

- e9799ca: feat: dead-letter handler — `engine.onDead` + `deadLetterWorkflow`

  Dead-lettering is no longer only "park the run in `dead`". `engine.onDead((run) => …)` fires when a
  run is moved to `dead` (exceeded `maxRecoveryAttempts`), so a DLQ handler can alert, push to a real
  queue, or compensate. The NestJS module adds a `deadLetterWorkflow` option that routes a dead run to
  a designated workflow with `{ deadRunId, workflow, input, error }` (idempotent by a `dlq:<runId>` id).
  Omitting both keeps the prior behaviour (the run stays parked, inspectable + retriable).

## 0.3.0

### Minor Changes

- df6524f: feat: cron + timezone schedules

  `ScheduledWorkflow` now accepts a `cron` expression with an IANA `timezone` (DST-aware) as an
  alternative to the fixed-interval `everyMs`. The run id is keyed on the most recent fire time, so
  polling repeatedly within an interval — or racing instances on the same tick — starts each fire
  exactly once (idempotent). The NestJS module gains a `schedules` option; the timer poller fires them
  each tick on **worker** instances only. Cron evaluation uses the optional `cron-parser` peer
  dependency, so the core stays dependency-free for users who don't schedule by cron.

- 3f79533: feat: dead-letter queue — `maxRecoveryAttempts` + `dead` run status

  Crash recovery now counts attempts per run (`WorkflowRun.recoveryAttempts`); once a still-`running`
  run exceeds the engine/module `maxRecoveryAttempts`, it's moved to the new terminal **`dead`** status
  instead of being retried forever — so a poison pill that crashes the process every boot becomes an
  inspectable dead-letter entry, not a crash loop. The new column is persisted by all four store
  adapters (TypeORM auto-schema self-heals it; Prisma/Drizzle/MikroORM schemas updated), and `dead` is
  added to the dashboard/codegen status unions. Omit `maxRecoveryAttempts` for the prior unlimited-retry behaviour.

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

## 0.2.1

### Patch Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

## 0.2.0

### Minor Changes

- Add a `worker` option to `DurableModule.forRoot/forRootAsync` (default `true`). Set `worker: false`
  for a **dashboard/dispatch-only** instance — typically an API pod — that mounts the control plane and
  keeps the engine available (dispatch, retry/cancel, reads) but does **not** play the worker role:
  it won't register `@DurableStep` handlers (no consuming the task queue), won't recover incomplete
  runs on boot, and won't poll due timers. Leave that to the worker instances. Lets you run the engine
  on `APP_TYPE=worker|all` and the dashboard everywhere without two instances competing to process work.
