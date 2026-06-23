# @dudousxd/durable-worker

## 0.2.0

### Minor Changes

- 256b8c3: Add a **thin Node/NestJS worker** — a control-plane-less worker (the Node analog of the Python `durable-worker`), so a plain Node/NestJS service can be a pure worker with no store, no engine, no recovery, and no dashboard. The single control-plane engine remains the sole owner of state; N thin workers (Python and now Node) just consume tasks → run handlers / replay workflow bodies → return `StepResult`/`WorkflowDecision` over BullMQ.

  New package `@dudousxd/durable-worker`:

  - `WorkflowContext` — `implements WorkflowCtx`, so a `@Workflow` body written against the engine's authoring API runs unchanged on the thin worker (history → commands replay). Wire-expressible ops (`step`, `call`, `sleep`, `waitForSignal`, `child`, `all`, `now/random/uuid`, plus a `gather` extension) are supported; ops needing engine/store features (`transaction`, `callEntity`, `webhook`, `setEvent`, `onUpdate`, `patched`, `task`, `continueAsNew`, `sleepUntil`, `waitForEvent`, fire-and-forget `startChild`) throw `UnsupportedOnThinWorker`.
  - `WorkflowWorker.processTask` / `StepWorker.processTask` — pure, transport-free decision/result producers.
  - A BullMQ runner that consumes the engine's task queues and returns decisions/results (queue names match `@dudousxd/nestjs-durable-transport-bullmq` exactly).

  `@dudousxd/nestjs-durable` gains `DurableWorkerModule.forRoot({ connection, groups })`: discovers `@Workflow`/`@DurableStep` providers and runs them on the thin worker runtime + BullMQ runner — a NestJS worker process with no `WorkflowEngine`/store bound. A conformance test proves the same `@Workflow` produces identical output and ordered `(seq, name, kind)` on the engine and the thin worker.
