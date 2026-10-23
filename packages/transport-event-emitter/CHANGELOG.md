# @dudousxd/nestjs-durable-transport-event-emitter

## 0.5.3

### Patch Changes

- [#404](https://github.com/DavideCarvalho/nestjs-durable/pull/404) [`b687ab6`](https://github.com/DavideCarvalho/nestjs-durable/commit/b687ab6e6f432cde1c16bb1cebad24fd3cae5044) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Correctness fixes ported from the AdonisJS sibling's audit.

  - `ctx.callEntity` and `ctx.signalEntity` are exactly once across replay. A replay of a `callEntity` still waiting for its reply used to send the operation again (two replays applied it three times), and a turn that died after a `signalEntity` dispatch applied it twice. The operation is now stored durably in the entity's buffer, tagged with the caller's `<runId>:<seq>`, before the caller checkpoints, and the entity's run is created with it. `callEntity` records a pending intent first and marks it as sent with a conditional write that never overwrites a reply that already landed. The entity skips a copy re-sent with the same id. The wake-up is a no-op message, so ops stay in arrival order, and a lost wake-up is recovered by the `reconcileMs` sweep.
  - `ctx.webhook().wait()` consumes a callback that arrived before the wait. `engine.signal` buffered it, but the wait never read the buffer, so the run waited forever. The wait now checks the buffer, registers, then checks again, like `ctx.waitForSignal`.
  - The dashboard's `POST webhooks/:token` buffers an early callback when the token's run exists and isn't terminal, and answers with the run's status. It answers `404` for a non-webhook token, an unknown or terminal run, or a wait that already resolved, and buffers nothing for those. Before, every unmatched POST left a buffered row behind and still answered `404`. A duplicate that races a callback resolving the same wait takes its buffered row back and answers `404`.
  - A child moved to `dead` by recovery (`maxRecoveryAttempts`) now notifies its parent right away as a failed child (`ctx.child` throws, `ctx.all`/`allSettled` record it). Before, the parent waited for its reconcile wake.
  - An empty-string namespace is the `default` pool. An engine configured with `namespace: ''` stamps and polls `'default'`, a run started with `{ namespace: '' }` is stamped `'default'`, and a run stamped `''` is no longer refused by a `'default'` engine's resume and decision guards. An unset namespace is still the operator. Every store writes `''` as `'default'`. The Drizzle stores (SQLite and Postgres) also read legacy `''` rows back as `'default'` and match them with every `'default'` filter. On the MikroORM, Prisma and TypeORM stores, rewrite legacy rows once with `UPDATE durable_workflow_runs SET namespace = 'default' WHERE namespace = ''`. Such rows exist only if an engine ran with `namespace: ''` before this release.
  - bullmq: a negative, NaN, infinite or above-2^31-1 `pingIntervalMs` falls back to the default instead of PINGing about every millisecond. A rejecting heartbeat handler is logged instead of becoming an unhandled rejection. When one `onDecision` handler fails, every handler runs to completion and each failure is reported before the decision is redelivered; before, the redelivery ran the others again while they were still running.
  - event-emitter transport: a rejection while processing a task goes to `onError` instead of becoming an unhandled rejection.

## 0.5.2

### Patch Changes

- [#394](https://github.com/DavideCarvalho/nestjs-durable/pull/394) [`3d29adb`](https://github.com/DavideCarvalho/nestjs-durable/commit/3d29adb1beb50a1db24efff1e798b97c6730d9f4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A result or heartbeat handler that rejects no longer becomes an unhandled rejection (fatal under Node's default). The error goes to the new `onError` option (`new EventEmitterTransport(emitter, { onError })`, default `console.error`), and a failed result is redelivered with backoff (100ms doubling, capped at 5s) until `close()` instead of being lost. Adds `close()`.

## 0.5.1

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

## 0.4.0

### Minor Changes

- 6836ace: refactor!: separate the control plane from the Transport

  `publishControl`/`onControl` are no longer part of `Transport`; they form a dedicated `ControlPlane`
  interface, and the engine takes a separate `controlPlane` dependency. This decouples cross-instance
  broadcast (lifecycle events + cancellation) from the point-to-point task transport, so you can run a
  dedicated control plane (e.g. Redis pub/sub) independent of how steps are dispatched. Broadcast-capable
  transports (event-emitter, BullMQ) implement `ControlPlane` too and can be passed as both; the NestJS
  module auto-wires the transport as the control plane when it qualifies, or accepts an explicit
  `controlPlane` option.

## 0.3.0

### Minor Changes

- **Transport control plane** — a broadcast pub/sub across all engine instances, unlocking the cross-pod features from the durability audit:

  - `Transport.publishControl(msg)` / `onControl(handler)` + a `ControlMessage` type. In-process transports (in-memory, event-emitter) broadcast locally; **BullMQ broadcasts over Redis pub/sub**. Optional — the engine degrades to local-only when a transport doesn't implement it.
  - **Cross-pod live-tail**: the engine now broadcasts lifecycle events, so a dashboard-only pod (`worker: false`) sees events from a run executing on a worker pod. The dashboard exposes `@Sse('runs/:id/stream')` and `durableClient.streamRun(id, onEvent)` — live updates without polling.
  - **Cooperative cancellation**: `engine.cancel(runId)` broadcasts the cancel; `engine.onCancel(fn)` lets a worker bridge abort in-flight work instead of finishing it just to have the result discarded. Events are deduped by originating `instanceId` so a broker echo doesn't double-deliver.

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
