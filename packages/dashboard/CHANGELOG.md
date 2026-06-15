# @dudousxd/nestjs-durable-dashboard

## 0.14.0

### Minor Changes

- 8ba981d: Signal-with-start (durable entities), cancel→child propagation, and low-latency dispatch.

  - **Reliable signals + `signalWithStart`**: a signal sent with no waiter is now **buffered** (FIFO per token) and delivered to the next `waitForSignal` — signals are never lost to timing. `engine.signalWithStart(workflow, input, runId, { token, payload })` / `workflowService.signalWithStart(...)` ensures a run exists then delivers a signal, race-free — the canonical **durable-entity / accumulator** pattern (one long-lived run per key fed events by many calls). New `StateStore.bufferSignal` / `takeBufferedSignal` (custom stores must add them; all bundled adapters do).
  - **Cancellation cascades to children**: `engine.cancel(parent)` now cancels the runs it started via `ctx.child` / `ctx.startChild` (recursively), and no longer clobbers an already-finished run.
  - **Low-latency cross-pod dispatch**: a run enqueued on one instance (e.g. an API pod) nudges worker instances over the control plane (`engine.onEnqueued`) to pick it up at once instead of on the next poll. The dashboard `/metrics` adds `durable_pending_runs` (dispatch backlog) + `durable_dead_runs` (DLQ size) gauges.

## 0.13.0

### Minor Changes

- c99508d: Self-healing recovery + non-blocking dashboard actions.

  - **Lease renewal**: while a run executes, the engine renews its recovery lease (every `leaseMs/2`), so a live worker keeps a long run while a **crashed** worker's lease still expires. `execute` now holds the lease for the whole run on every entry path (sweep, signal, remote result, dashboard), so a run is never double-executed. New `StateStore.renewRunLock(runId, owner, leaseUntilMs)` — **custom stores must add it**.
  - **Periodic orphan recovery**: the NestJS `TimerPoller` now calls `engine.recoverIncomplete()` each tick, so a run orphaned by a crashed worker self-heals within ~`leaseMs` instead of only on the next boot.
  - **Non-blocking control actions** (fixes the `/durable` retry/cancel request hanging): `retry` now re-enqueues via the new `engine.requeue(runId)` (sets `pending` + dispatches) and `cancel({ compensate })` runs the undo in the background — neither replays the workflow inline in the HTTP request anymore. A worker does the work.

## 0.12.0

### Minor Changes

- a5fd901: **Breaking (0.x minor): `start` now dispatches to a worker instead of running the workflow inline.**

  Previously `engine.start` / `WorkflowService.start` executed the workflow body inline and returned the terminal `RunResult`. Now `start` only **enqueues**: it creates the run as a new `'pending'` status, hands it to a `RunDispatcher`, and returns `{ runId, status: 'pending' }` immediately — the body runs on a worker, so the caller (e.g. an HTTP handler) never blocks on workflow logic.

  **Migration**

  - To await the outcome, use the new `engine.waitForRun(runId)` / `workflowService.waitForRun(runId)` — resolves once the run settles (terminal or suspended). `const { runId } = await start(...); const result = await waitForRun(runId)`.
  - **Default behavior is unchanged for single-process apps**: the default in-process dispatcher executes the run on the same instance (asynchronously), so runs still execute with no extra setup.
  - **Offload to workers**: pass a no-op `runDispatcher` on API/dashboard instances (or set NestJS `worker: false`) so they enqueue-only; worker instances poll `engine.runPending()` (the NestJS `TimerPoller` now does this each tick) to pick up `pending` runs. A broker-backed dispatcher can enqueue to a queue whose workers call `engine.runOne(runId)`.

  New: `RunStatus` gains `'pending'`; engine gains `runOne`, `runPending`, `waitForRun`; `WorkflowEngineDeps.runDispatcher`. The testing harness gains `createTestEngine().run(...)` (start + wait) and the dashboard shows the `pending` state. `StateStore` gains `listPendingRuns(limit)` (oldest-first / FIFO) — **custom store implementations must add it** (all bundled adapters do).

- a5fd901: Typed search attributes — query runs by structured data, not just exact-match tag labels.

  - **Start**: `start(wf, input, id, { searchAttributes: { amount: 200, tier: 'pro' } })` stamps typed, queryable data on a run.
  - **Query**: `RunQuery.attributes` takes `{ key, op, value }` predicates ANDed together, with `eq/ne/gt/gte/lt/lte` — so range queries like `amount >= 200 AND tier = 'pro'` work. Applied in-process after the coarse workflow/status/tag filters, so it's portable across all store adapters (typeorm/prisma/mikro-orm/drizzle gain a `searchAttributes` JSON column).
  - **Dashboard**: an attribute filter box (`amount:gte:200, tier:eq:pro`), attribute pills on the run detail, and bulk retry/cancel honoring the same predicates. API: `GET /runs?attr=key:op:value` (repeatable).

## 0.11.0

### Minor Changes

- c776428: feat(dashboard): bulk retry/cancel by filter

  Act on many runs at once: when a status or tag filter is active, the run list shows **retry all** /
  **cancel all** buttons that apply to every matching run (e.g. "retry every `dead` run tagged
  `type:mel`"). Backed by a new `POST bulk/:action?status=&tag=&workflow=` endpoint + `DashboardService.bulk()`
  (capped at 500, terminal runs skipped, returns matched/applied counts).

- 12c91ff: feat: Prometheus metrics

  `collectMetrics(engine)` subscribes to the engine's lifecycle events and accumulates dependency-free
  counters — runs + steps by outcome, per-workflow run counts, step-duration sum/count. Call
  `.prometheus()` for the text exposition or `.snapshot()` for raw numbers. The dashboard wires it
  automatically and serves it at `GET <apiBasePath>/metrics` for a scrape.

## 0.10.0

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

## 0.9.0

### Minor Changes

- 6979d60: feat(dashboard): per-sub-process spans in the timeline waterfall

  A step that fans out into sub-processes (e.g. parallel p-processes recorded via the step logger) now
  expands into a mini-waterfall under its bar — one sub-bar per sub-process, placed across the step's
  own window and colored by outcome (ok / failed / skipped) — instead of a single opaque bar. Steps
  with no sub-processes render exactly as before.

## 0.8.0

### Minor Changes

- 7a8d5b8: feat(dashboard): give dead-letter runs a distinct look

  A dead-letter run is a recovery path, not the happy flow — so it now reads as one instead of
  looking like a normal run. A `dlq:<id>` handler run shows a rose **DLQ** pill next to its title and
  a prominent banner ("Dead-letter handler — started because run X was dead-lettered" + open-dead-run
  button); a `dead` run that was routed to a handler shows the mirror banner ("Dead-lettered — routed
  to a DLQ handler" + open-handler button). Dead-letter handler runs are also tagged **dlq** in the
  runs list so they stand out among normal runs. Replaces the old single inline link.

## 0.7.0

### Minor Changes

- de951cf: feat(dashboard): child-workflow nodes link to their child run

  Child workflows are now first-class in the run view. A step that ran another workflow —
  `ctx.child` (awaited) or `ctx.startChild` (fire-and-forget) — is rendered with a distinct
  child glyph and an indigo "child ↗" marker in both the graph and the spans timeline.
  Clicking it opens the child's run, so you can walk parent → child the same way the
  dead-letter link walks dead → handler. Detection is by checkpoint name (`spawn:<id>` /
  `signal:child:<id>`), so no API/wire change is needed.

## 0.6.1

### Patch Changes

- f0621a6: feat(dashboard): link the two ends of a dead-letter relationship

  A run's detail now shows the DLQ relationship both ways: a `dead` run that was routed to a
  `dlq:<id>` handler links forward to it (probed so the link only shows when the handler exists), and a
  `dlq:<id>` handler run links back to the dead run it's handling. Makes the "normal path failed → went
  to the DLQ" flow navigable instead of two disconnected runs.

## 0.6.0

### Minor Changes

- 0900830: feat: compensating cancellation — `engine.cancel(runId, { compensate: true })`

  Cancelling a run can now undo its saga first: the suspended run is resumed with a cancellation
  pending, so replay re-registers the saga and its completed steps' compensations run in reverse
  (visible as `compensate:<step>` events) before the run is marked cancelled. Plain `cancel()` is
  unchanged (immediate, no undo). The dashboard's cancel accepts `?compensate=true`
  (`durableClient.cancel(id, { compensate: true })`), and the codegen client exposes the flag.

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

- f915e2c: feat: synchronous queries & validated updates

  Two Temporal-style primitives adapted to the suspend/checkpoint model:

  - **Query** — `ctx.setEvent(key, value)` publishes a named, replay-safe value; `engine.getEvent(runId, key)`
    reads the latest value of a live (or finished) run with no side effect. Exposed as
    `GET runs/:id/events/:key`.
  - **Update** — `ctx.onUpdate(name)` is a run-scoped update point; `engine.update(runId, name, arg)`
    delivers to it, gated by a validator registered with `engine.registerUpdateValidator(workflow, name, fn)`
    that can **reject before the run is touched** (`{ accepted: false, reason }`). Exposed as
    `POST runs/:id/updates/:name`. The codegen extension emits both routes into the typed client.

### Patch Changes

- 792639d: feat(dashboard): "Cancel + Undo" action and the `dead` status

  The run view gains a **Cancel + Undo** button that cancels with saga compensation
  (`durableClient.cancel(id, { compensate: true })`) alongside the plain Cancel, and the new `dead`
  dead-letter status is rendered (filter chip + badge colour).

## 0.5.1

### Patch Changes

- The `/durable` run view now live-tails over the SSE stream (`streamRun`): it refreshes the instant an event lands instead of waiting for the poll, with the 1.5s poll kept as a fallback. Cross-pod when the server transport has a control plane.

## 0.5.0

### Minor Changes

- **Transport control plane** — a broadcast pub/sub across all engine instances, unlocking the cross-pod features from the durability audit:

  - `Transport.publishControl(msg)` / `onControl(handler)` + a `ControlMessage` type. In-process transports (in-memory, event-emitter) broadcast locally; **BullMQ broadcasts over Redis pub/sub**. Optional — the engine degrades to local-only when a transport doesn't implement it.
  - **Cross-pod live-tail**: the engine now broadcasts lifecycle events, so a dashboard-only pod (`worker: false`) sees events from a run executing on a worker pod. The dashboard exposes `@Sse('runs/:id/stream')` and `durableClient.streamRun(id, onEvent)` — live updates without polling.
  - **Cooperative cancellation**: `engine.cancel(runId)` broadcasts the cancel; `engine.onCancel(fn)` lets a worker bridge abort in-flight work instead of finishing it just to have the result discarded. Events are deduped by originating `instanceId` so a broker echo doesn't double-deliver.

## 0.4.1

### Patch Changes

- Fix the `./client` SDK export: the build now rebuilds `dist/client` (it was stale — shipping the pre-0.2.0 `StepCheckpoint` with no `input`/`events`/`pending`) and `package.json` declares the `./client` subpath export so `@dudousxd/nestjs-durable-dashboard/client` resolves with the current types (`StepEvent`, `StepCheckpoint.events`, the `pending` status).

## 0.4.0

### Minor Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

## 0.3.0

### Minor Changes

- Add `apiBasePath` to `DurableDashboardModule.forRoot` so the UI and its JSON API can mount on
  different paths: serve the SPA at a page-friendly `basePath` (e.g. `/durable`) while the API lives
  under your app's `/api` prefix (e.g. `apiBasePath: '/api/durable'`) to inherit its auth/proxy. The
  SPA is told its API base at serve time. Defaults to `<basePath>/api`, so existing mounts are
  unchanged.

## 0.2.2

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

## 0.2.1

### Patch Changes

- Record a step's **input** on its checkpoint, alongside the output. A remote step's `ctx.call` args
  are now persisted and surfaced in the dashboard step panel ("Input" + "Output" shown separately,
  instead of only the output) — so you can see what a step was called with, not just what it returned.
  Stored as a nullable column across all four store adapters; the in-memory store carries it for free.

## 0.2.0

### Minor Changes

- Make the dashboard mount path configurable via `DurableDashboardModule.forRoot({ basePath })`.
  Previously the control plane was hardcoded to `/durable`; now you can mount it anywhere — e.g.
  `forRoot({ basePath: '/api/durable' })` to bring it under your app's `/api` prefix so its auth/proxy
  rules cover the dashboard API too. The SPA's asset URLs and API base are derived from `basePath` at
  serve time, so the bundle works at any mount point.

  **Breaking:** import via `DurableDashboardModule.forRoot()` instead of the bare `DurableDashboardModule`
  (`forRoot()` with no args keeps the previous `/durable` default). Requires `@nestjs/core` as a peer
  (for `RouterModule`) — already present in every NestJS app.

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
