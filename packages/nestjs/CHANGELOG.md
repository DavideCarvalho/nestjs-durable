# @dudousxd/nestjs-durable

## 1.0.0

### Major Changes

- 4762866: **Breaking: `start` now dispatches to a worker instead of running the workflow inline.**

  Previously `engine.start` / `WorkflowService.start` executed the workflow body inline and returned the terminal `RunResult`. Now `start` only **enqueues**: it creates the run as a new `'pending'` status, hands it to a `RunDispatcher`, and returns `{ runId, status: 'pending' }` immediately — the body runs on a worker, so the caller (e.g. an HTTP handler) never blocks on workflow logic.

  **Migration**

  - To await the outcome, use the new `engine.waitForRun(runId)` / `workflowService.waitForRun(runId)` — resolves once the run settles (terminal or suspended). `const { runId } = await start(...); const result = await waitForRun(runId)`.
  - **Default behavior is unchanged for single-process apps**: the default in-process dispatcher executes the run on the same instance (asynchronously), so runs still execute with no extra setup.
  - **Offload to workers**: pass a no-op `runDispatcher` on API/dashboard instances (or set NestJS `worker: false`) so they enqueue-only; worker instances poll `engine.runPending()` (the NestJS `TimerPoller` now does this each tick) to pick up `pending` runs. A broker-backed dispatcher can enqueue to a queue whose workers call `engine.runOne(runId)`.

  New: `RunStatus` gains `'pending'`; engine gains `runOne`, `runPending`, `waitForRun`; `WorkflowEngineDeps.runDispatcher`. The testing harness gains `createTestEngine().run(...)` (start + wait) and the dashboard shows the `pending` state. `StateStore` gains `listPendingRuns(limit)` (oldest-first / FIFO) — **custom store implementations must add it** (all bundled adapters do).

### Minor Changes

- c648786: Event-triggered workflows: a workflow can now **start** on a published event, not just wait for one.

  - **Core**: `engine.register(name, version, fn, { onEvent: ['user.registered'] })` — `publishEvent(name, payload, { id })` now starts a fresh run of every subscribed workflow (payload becomes the input) in addition to resuming `waitForEvent` waiters. Idempotent by `evt:<id>:<workflow>`; the return count includes both resumed and started runs.
  - **NestJS**: `@Workflow({ onEvent: [...] })` **or** a dedicated `@OnEvent('a', 'b')` class decorator (listen to several events; both forms merge). `workflowService.publishEvent(name, payload, { id })` gained the dedup id.

- f1e7999: Input validation at workflow start. The engine now rejects a bad payload **before any run is created**, so invalid input never produces a dead/failed run.

  - **Core** (validator-agnostic): `engine.register(name, version, fn, { validateInput })` — a `(input) => void | Promise<void>` that throws to reject.
  - **NestJS** (class-validator, the controller default): `@Workflow({ inputSchema: CheckoutInput })` validates with the same `plainToInstance` + `validate` NestJS runs in controllers. `class-validator` + `class-transformer` are lazy-required optional peers. For zod/yup/etc. pass `@Workflow({ validateInput })` instead (it wins over `inputSchema`).

- f1679e5: Typed search attributes — query runs by structured data, not just exact-match tag labels.

  - **Start**: `start(wf, input, id, { searchAttributes: { amount: 200, tier: 'pro' } })` stamps typed, queryable data on a run.
  - **Query**: `RunQuery.attributes` takes `{ key, op, value }` predicates ANDed together, with `eq/ne/gt/gte/lt/lte` — so range queries like `amount >= 200 AND tier = 'pro'` work. Applied in-process after the coarse workflow/status/tag filters, so it's portable across all store adapters (typeorm/prisma/mikro-orm/drizzle gain a `searchAttributes` JSON column).
  - **Dashboard**: an attribute filter box (`amount:gte:200, tier:eq:pro`), attribute pills on the run detail, and bulk retry/cancel honoring the same predicates. API: `GET /runs?attr=key:op:value` (repeatable).

- 46c293b: Step interceptors — onion middleware around the real execution of every local `ctx.step` (timing, logging, tracing, error enrichment, context propagation). They fire **only when a step actually executes, never on replay**, so timing/metrics reflect true work.

  - **Core**: `engine.use((invocation, next) => ...)` — `invocation` carries `{ runId, workflow, stepName, seq, attempt }`; `next()` runs the step body / next interceptor and returns its result. First registered is outermost. Returns an unsubscribe.
  - **NestJS**: `@StepInterceptor()` on an `@Injectable()` class implementing `DurableStepInterceptor` (so it can inject loggers/tracers). Discovered and wired on boot.

### Patch Changes

- Updated dependencies [4762866]
- Updated dependencies [c648786]
- Updated dependencies [f1e7999]
- Updated dependencies [f1679e5]
- Updated dependencies [46c293b]
  - @dudousxd/nestjs-durable-core@1.0.0

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
