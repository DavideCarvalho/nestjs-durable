# @dudousxd/durable-worker

## 0.3.2

### Patch Changes

- a2be405: Add `ctx.upsertSearchAttributes(attrs)` — set a run's indexed `searchAttributes` from inside the workflow, without injecting the store.

  Previously, tagging the run you're executing meant injecting the raw state-store token into a `@Workflow` and calling `store.getRun(ctx.runId)` + `store.updateRun(ctx.runId, { searchAttributes })` — awkward, and it coupled the workflow to store access. Now:

  ```ts
  // before
  @Inject(STATE_STORE) private readonly store: StateStore;
  const run = await this.store.getRun(ctx.runId);
  await this.store.updateRun(ctx.runId, {
    searchAttributes: { ...(run?.searchAttributes ?? {}), key: value },
  });

  // after — no injection at all
  await ctx.upsertSearchAttributes({ key: value });
  ```

  Shallow-merges into the run's `searchAttributes` (keys you don't pass are kept). Durable + **exactly-once**: recorded at its position on the first run and skipped on replay (one write, not one per turn), nondeterminism-guarded like every other ctx primitive — it mirrors `ctx.transaction`'s record-once semantics. On the thin `@dudousxd/durable-worker` (no store) it throws `UnsupportedOnThinWorker` — run such a workflow in-process on the engine.

## 0.3.1

### Patch Changes

- 27e79cc: Ship `@dudousxd/durable-worker` as a dual ESM + CJS build (was ESM-only).

  A NestJS app compiled to CommonJS (SWC's default) reaches this package through
  `@dudousxd/nestjs-durable`'s `DurableWorkerModule`, which `require()`s it. With an
  ESM-only `exports` (no `require`/`default` condition), that `require` threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED` at boot → CrashLoopBackOff for any CJS consumer.
  The package now publishes `dist/index.cjs` + `dist/index.js` with matching
  `import`/`require` export conditions (mirroring `@dudousxd/nestjs-durable`), so both
  CJS and ESM consumers load it. No API change.

## 0.3.0

### Minor Changes

- 31b1389: Track A liveness-rearm: a per-run heartbeat that lets a remote workflow `advance` self-heal a dead worker without re-driving a live (slow) one.

  - **core:** new opt-in `WorkflowEngineDeps.remoteAdvanceSilenceMs`. When set, the engine wraps the remote workflow `advance` in a heartbeat-rearmed deadline keyed by `runId`: each run-scoped `Heartbeat` (a beat with no `stepId`) rearms the window, and only a genuinely-silent worker trips `RemoteWorkflowTimeout` → lease released → recovery re-drives. This closes the duplicate-side-effect hazard of a fixed `RemoteWorkflowExecutor` `timeoutMs` (which can fire mid-step on a still-working worker). Default unset = prior unbounded await — no behavior change. `Heartbeat.stepId` is now optional to carry run-scoped beats. Internally, the per-step liveness helper was generalized into a single `awaitWithLivenessDeadline` reused by both the step and workflow paths.
  - **durable-worker:** the Node workflow worker now emits a run-scoped heartbeat on the shared `<prefix>-heartbeat` channel while replaying a turn (immediate + every 5s, cleared on settle), so an engine configured with `remoteAdvanceSilenceMs` keeps a slow-but-alive worker alive instead of re-driving it.

## 0.2.0

### Minor Changes

- 256b8c3: Add a **thin Node/NestJS worker** — a control-plane-less worker (the Node analog of the Python `durable-worker`), so a plain Node/NestJS service can be a pure worker with no store, no engine, no recovery, and no dashboard. The single control-plane engine remains the sole owner of state; N thin workers (Python and now Node) just consume tasks → run handlers / replay workflow bodies → return `StepResult`/`WorkflowDecision` over BullMQ.

  New package `@dudousxd/durable-worker`:

  - `WorkflowContext` — `implements WorkflowCtx`, so a `@Workflow` body written against the engine's authoring API runs unchanged on the thin worker (history → commands replay). Wire-expressible ops (`step`, `call`, `sleep`, `waitForSignal`, `child`, `all`, `now/random/uuid`, plus a `gather` extension) are supported; ops needing engine/store features (`transaction`, `callEntity`, `webhook`, `setEvent`, `onUpdate`, `patched`, `task`, `continueAsNew`, `sleepUntil`, `waitForEvent`, fire-and-forget `startChild`) throw `UnsupportedOnThinWorker`.
  - `WorkflowWorker.processTask` / `StepWorker.processTask` — pure, transport-free decision/result producers.
  - A BullMQ runner that consumes the engine's task queues and returns decisions/results (queue names match `@dudousxd/nestjs-durable-transport-bullmq` exactly).

  `@dudousxd/nestjs-durable` gains `DurableWorkerModule.forRoot({ connection, groups })`: discovers `@Workflow`/`@DurableStep` providers and runs them on the thin worker runtime + BullMQ runner — a NestJS worker process with no `WorkflowEngine`/store bound. A conformance test proves the same `@Workflow` produces identical output and ordered `(seq, name, kind)` on the engine and the thin worker.
