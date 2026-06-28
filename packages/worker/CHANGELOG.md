# @dudousxd/durable-worker

## 0.4.0

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

- e228dcd: Add a `concurrency` option to every worker surface (BullMQ Worker concurrency). Defaults to 1
  (unchanged), so a fanned-out batch — e.g. the N remote steps of a `gather` — can run in parallel
  instead of serially. Available on `BullMQTransport({ concurrency })`, `runRedisWorker({ concurrency })`,
  the NestJS in-app worker (`concurrency`), and the multi-group worker module (`concurrency` +
  per-group `concurrencyByGroup`). The Python SDK gains the same knob (`Worker(concurrency=…)`).
  Total parallelism is `concurrency × replicas`. See `docs/workers-when-to-use.md`.

## 0.3.4

### Patch Changes

- 3f8595f: Uniform dispatch, Phase 3: an opt-in in-app worker, plus the single-context-contract guarantee that makes it safe. The default is NOT flipped — group-routed dispatch stays strictly opt-in.

  **`@dudousxd/nestjs-durable` — in-app worker (opt-in).** `DurableModule.forRoot({ ..., inAppWorker: { group, connection } })` turns one Nest app into both roles: every discovered `@Workflow` is registered GROUP-SERVED (its turns are dispatched to the app's own `group` over the transport via a `RemoteWorkflowExecutor`, instead of run inline), and a co-located `DurableWorkerRuntime` consumes that group (`runRedisWorker`) and replays the SAME discovered TS bodies; `@DurableStep` handlers register on the same runtime. This is the uniform-dispatch "one app, both roles, own group" shape — every turn pays a broker round-trip even though the worker is the same process. It requires a workflow-task transport (BullMQ) and fails fast otherwise. Strictly additive and isolated: the providers are inert when `inAppWorker` is unset (the binding resolves to `null`, the bootstrap no-ops), so a plain `DurableModule` and the inline fast path are byte-for-byte unchanged. New exports: `DurableInAppWorkerOptions`, `InAppWorkerBootstrap`, and the `IN_APP_*` tokens (incl. `IN_APP_RUN_REDIS_WORKER` for testing without Redis).

  **`@dudousxd/durable-worker` — the one-contract guarantee.** The inline runtime (`createWorkflowCtx`, store-coupled) and the replay runtime (`WorkflowContext`, store-less) are two intentionally distinct implementations of ONE `WorkflowCtx` contract; they must agree wherever the contract is observable or a run checkpointed on one and resumed on the other corrupts. New conformance specs pin that: (a) the full inline `WorkflowCtx` surface exists on `WorkflowContext` — the exact drift that surfaced as the `durable-worker.module.ts:76` typecheck failure when `ctx.upsertSearchAttributes` was added to the contract but a stale build of the replay runtime lacked it (now resolved); and (b) both runtimes allocate identical seqs and record identical `(seq, name, output)` for local steps across a suspend, plus the unbounded-wait one-seq rule. An end-to-end spec proves "engine + worker in one app, own group" through the REAL `RemoteWorkflowExecutor` + `WorkflowWorker` over a transport seam, across complete / suspend-resume / recovery / cancel.

  **Default not flipped (deliberate).** Benchmarked the per-turn cost: an in-process (loopback) hop is within noise of zero, but over a real BullMQ/Redis broker each turn costs ~4–6 ms (local Redis, serialized) and that multiplies by a workflow's turn count and grows on networked/loaded production Redis. Flipping the default would also break every consuming app not configured with a workflow-task transport + in-app worker. So uniform dispatch ships opt-in; flipping the default would additionally require engine-level default-group resolution in `execute()`/`resume()` (the highest-risk, replay-path change) and is left for a future, separately-benchmarked phase.

## 0.3.3

### Patch Changes

- 0e55a3f: Propagate a step handler's `retryable` verdict on the thin-worker path. `toError` (used by `StepWorker.processTask`) copied `message`/`code`/`stack` off a thrown `Error` but dropped `retryable`, so a thin worker that threw a non-retryable error (e.g. `Object.assign(new Error('declined'), { retryable: false })`) was retried anyway — inconsistent with the in-process/transport path (`runStepHandler` in core's `protocol.ts`), which honours it. `toError` now carries `retryable` onto the wire `StepError` when present, so the engine's durable retry (`existing.error?.retryable !== false`) respects a worker's "don't retry this" verdict.

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
