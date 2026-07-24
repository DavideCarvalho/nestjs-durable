# @dudousxd/durable-worker

## 0.8.0

### Minor Changes

- b7568e3: Ambient step logger — record step events from anywhere inside a handler, without threading the `StepLogger` down.

  The Python SDK has had context-local step access for a while (`current_step`, `log`, `sub`, `sub_event`, `sub_process`); TypeScript only ever handed the `StepLogger` to the step body as its second argument. A generic utility a few layers below the handler (a batch inserter, an HTTP client) therefore could not emit without every signature on the path being edited — which contradicts the library's own goal that "observability is symmetric regardless of where the step ran".

  **core** — new `ambient-step.ts`, mirroring `ambient-ctx.ts` (the `AsyncLocalStorage` lives on `globalThis` under a `Symbol.for` key, so duplicate copies of core in a dependency tree share one storage):

  - `runInStepLogger(logger, fn)` / `currentStep(): StepLogger | undefined`
  - module-level shortcuts for the logger surface: `sub(...)`, `subEvent(...)`, `subProcess(name, body, opts?)`
  - log lines in both spellings: `debug` / `info` / `warn` / `error` (one per `StepLogger` method — the idiomatic TS form, for a level known at the call site) and `log(level, message, data?)` (the literal twin of the Python SDK's `log`, for a level that is computed)

  The engine installs the ALS at every point a logger is born — the local-step path (`ctx.step` in `workflow-ctx.ts`) and the remote-worker path (`runStepHandler`, so every transport gets it) — binding the SAME instance the body already receives as its argument, never a second one. Concurrent step invocations each see their own logger.

  **worker** — the thin worker runtime binds it too, on both its step-handler path (`StepWorker.processTask`) and its local-step path (`WorkflowContext.runStepBody`).

  Outside a step everything is a no-op: `currentStep()` returns `undefined`, `log`/`sub`/`subEvent` do nothing, and `subProcess` still runs its body (and still hands it a handle) but emits nothing. That is what lets a generic utility be instrumented with no `if` at the call site and stay usable in a unit test with no durable run around it.

  Purely additive: the `StepLogger` second argument is unchanged.

## 0.7.1

### Patch Changes

- 161c574: Cross-runtime control-flow recognition: workflow catch blocks that clean up on REAL failures had
  no reliable way to let the engine's control-flow exceptions through — `instanceof
WorkflowSuspended` fails when the workflow executes on the thin worker, whose `ctx.step`/
  `waitForSignal` suspends throw `@dudousxd/durable-worker`'s `Suspend` instead. A consumer that
  misclassified a thin-worker suspend as a failure ran its cleanup DURING the suspend, emitted
  extra checkpoints into history, and the resumed replay died with NondeterminismError.

  All three control-flow signal classes (core's `WorkflowSuspended`/`ContinueAsNew`, worker's
  `Suspend`) now carry the well-known marker `Symbol.for('aviary:durable:control-flow')`, and core
  exports `isWorkflowControlFlowSignal(error)` — the ONE predicate workflow code should use in
  catch paths: recognized signals must be rethrown untouched. `Cancelled` and `StepFailed` are
  deliberately NOT control-flow (a terminal the consumer may handle, and a real failure); the thin
  worker's `continueAsNew` throws `UnsupportedOnThinWorker`, a usage error, also excluded.

## 0.7.0

### Minor Changes

- 54dc0af: Class-first workflow API: `@Workflow` classes extending the new `DurableWorkflow` base gain `MyWorkflow.start(input)` (fire-and-forget — `engine.start` outside a workflow, a parent-linked `ctx.startChild` inside one) and `MyWorkflow.execute(input)` (run-and-await the typed output — `ctx.child` inside, start + wait-until-terminal outside), with input/output inferred from the subclass's own `run` signature. Powered by a new ambient workflow context (`AsyncLocalStorage`) the engine and the thin worker install around every body execution (`currentWorkflowCtx()`), per-class engine bindings written by the registrar at boot (`bindWorkflowClass`), and `waitForRun`'s new `until: 'terminal'` option.

## 0.6.0

### Minor Changes

- ec56a9c: Route durable work by **handler name** instead of a declared `group`, and rename the isolation axis to `partition`. The API surface shrinks and the common case needs no `group`/`groups` ceremony.

  - **`ctx.remote(step, input)`** is the remote-step dispatch method; **`ctx.call` is a deprecated back-compat alias** of it (identical dispatch).
  - **`RemoteStepDef.group` is replaced by optional `RemoteStepDef.partition`.** Routing is now keyed by the step's `name`; `partition` is only an isolation suffix. `remoteStep({ group })` is a deprecated alias mapped onto `partition`. The dispatched queue token is `tenantGroup(sanitizeQueueToken(name), partition)` (new `sanitizeQueueToken` replaces `:` with `-`, which BullMQ forbids in queue names; exported from the package root).
  - **Workers subscribe per registered handler name, not per group.** `DurableWorkerModule` derives its subscriptions from the discovered `@Workflow`/`@Step` — `groups` is now optional/deprecated (ignored) and `tenant` is a deprecated alias for the new `partition`. `BullMQTransport` starts one consumer per registered handler (its `group` option is a deprecated alias for `partition`). The thin `runRedisWorker` and `DurableWorkerRuntime.registeredNames()` back this. In-app group-served workflows dispatch each turn under their own name-derived token.
  - **Execution model is unchanged** (stateless replay-per-turn) and now regression-locked.

  Migration is non-breaking via the deprecation aliases above — each consumer's source migrates independently. **The wire format (queue naming) is a coordinated atomic change:** the durable fleet (operator + every runtime worker, JS and Python) must deploy together for this release, as it already must for any routing change.

  **Known limitation (follow-up):** only `BullMQTransport` is migrated to per-handler subscription. `DbTransport` and `SqsTransport` still use the flat single-`group` consumer model (they interoperate with the new engine because dispatch carries the computed token, but a worker instance serves one token, not one-per-handler). SQS additionally rejects `.` in queue names, which `sanitizeQueueToken` does not strip. Migrate these if/when needed.

- 988ec4c: Collapse the local/remote step split into ONE durable step primitive (breaking, 0.x).

  - **One `ctx.step`, always dispatched, always engine-scheduled.** `ctx.step(handlerRef | name, input, opts?)` is the only step primitive — no author-facing placement choice. Pass a `@Step`-decorated method **reference** (name + types read off the stamped method — refactor-safe, autocompleted) or a **name string** for a cross-runtime handler (e.g. a Python `@step`). Both forms emit the identical dispatch; a step runs on whatever worker serves that name. Crossing a _workflow_ boundary is unchanged — still `ctx.child`.
  - **`@Step` carries the identity.** `@Step()` derives the routing name from the method (`Class.method`); `@Step('custom:name')` overrides it; `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?, backoffMaxMs?, jitter?, timeoutMs? })` adds opt-in runtime zod validation and a **declared retry/timeout policy** the engine applies to every dispatch of that step. `StepDispatchOpts` (the per-call `ctx.step(..., opts)` third argument) can override any of `retries`/`backoff`/`backoffMs`/`backoffMaxMs`/`jitter`/`timeoutMs` field-by-field on top of the `@Step`-declared value, plus the existing `queue`/`priority`/`fairnessKey`/`transport`.
  - **New deterministic-capture primitives.** `ctx.sideEffect(fn)` runs `fn` once, checkpoints the result, and replays the SAME value thereafter (Temporal's `sideEffect`) — the author picks the generator: `ctx.sideEffect(() => uuidv7())`, `() => ulid()`, `() => Math.random()`, a config/env read. `ctx.now()` returns epoch **ms** (like `Date.now()`), the one ubiquitous convenience kept as a lightweight built-in.
  - **Removed, no deprecation aliases:** `ctx.remote` (→ `ctx.step`), the inline `ctx.step(name, closure)` form (→ a `@Step` method dispatched via `ctx.step(this.svc.method, input)`, or `ctx.sideEffect`/`ctx.now()` for a non-dispatched capture), `remoteStep()` and `RemoteStepDef` (identity now lives on the `@Step` method itself — nothing to declare separately), `ctx.uuid()` and `ctx.random()` (→ `ctx.sideEffect(() => ...)`, so the algorithm is exactly what the author chooses). `@DurableStep` stays as a back-compat alias of `@Step` (unaffected).
  - **`@dudousxd/nestjs-durable-eslint-plugin` / the GritQL rule** flag differently: a closure is only treated as checkpointed inside `ctx.sideEffect(...)`/`ctx.task(...)` now (no longer `ctx.step(...)`, which never takes a closure), and the `useRandom`/`useUuid` messages point at `ctx.sideEffect(() => ...)` instead of the removed `ctx.random()`/`ctx.uuid()`.

  No wire/history/protocol change — `ctx.step` emits the same `{ kind: 'call', seq, name, group, input }` decision and `Suspend` that `ctx.remote` emitted, so route-by-handler, partitioning, convention dispatch, and `gather`/`all` fan-out are unchanged; only the authoring surface moved. The durable fleet (engine + JS/Python workers) adopts the new surface together, as every prior routing/surface cut required. Python's `durable-worker` (PyPI) gets the same cut — `.step(name, input)` always dispatched, `.now()`/`.side_effect(fn)` added, `.call`/baked uuid/random removed — bumped separately on PyPI, not through this changeset.

- 6f24040: Collapse the role-declaration surface and drop the Phase-1 deprecation aliases (breaking, 0.x).

  - **One module, role inferred.** `DurableModule.forRoot(options)` is the only entry point. `{ store, transport }` → operator (engine + store + drivers, executes bodies inline). `{ connection }` (no store) → thin worker (store-less start client + `ProxyRunGateway` + one queue subscribed per registered `@Workflow`/`@Step`). `{ store, transport, connection }` → operator that dispatches its own bodies to a co-located per-name worker (uniform dispatch). `partition?` is the only isolation knob; `drive?` (default true for an operator) stays for read-only store replicas. **`DurableWorkerModule`, `DurableControlPlaneModule`, and the `inAppWorker` option are removed** — folded into `DurableModule`.
  - **Convention dispatch is the default.** The `remoteByConvention` flag is removed: an operator with no local body for a workflow and a live worker of that name dispatches to it automatically (route-by-name makes it correct by construction); an unknown workflow still throws `not registered`.
  - **Deprecation aliases removed.** `ctx.call` (use `ctx.remote`), `remoteStep({ group })` (use `partition`), `DurableWorkerModule` `groups`/`tenant`/`concurrencyByGroup`, `BullMQTransport({ group })` (use `partition`), Python `Worker(group=/tenant=)` (use `partition`). Python bumped to `0.21.0b0`.

  Canonical config is now two shapes: operator `{ store, transport }`, worker `{ connection, partition? }` — everything served is derived from the `@Workflow`/`@Step` decorators. Breaking cut; the durable fleet (operator + JS/Python workers) adopts the new surface together, as it already must for any routing change.

- ecce3ca: Add `startRun(connection, opts)` function (P4 — tenant worker → control plane). Publishes a `StartRunMessage` onto `<effectivePrefix>-start-run` using BullMQ, supporting the namespace-prefix rule via the new `effectivePrefixOf` helper. Also exports `effectivePrefixOf` and `startRunName` from `runner-core` for callers that need to compute names directly.
- b7c63a5: `runRedisWorker` accepts a new `tenant` option, DISTINCT from `prefix` (the transport prefix is
  untouched — typically shared with the operator control plane). Only the worker GROUP it
  registers/heartbeats under is derived via `tenantGroup(group, tenant)`
  (`@dudousxd/nestjs-durable-core`): `undefined`, `''`, or `'default'` stays byte-identical to the
  bare `group` (production unchanged); any other tenant becomes `<group>@<tenant>`, so an
  operator's `listWorkerGroups()`/`resolveRemoteByConvention` can route that tenant's runs to this
  worker instance. `tenantGroup` is now also re-exported from `@dudousxd/nestjs-durable-core`'s
  package root (it was previously only an internal module).
- de58581: Uniform durable start for tenant apps. `engine.start(...)` is now identical across topologies: a
  tenant worker (no store) resolves the same `WorkflowEngine` token to a store-less `DurableStartClient`
  that transparently publishes a start-run message to the control plane instead of touching a DB.
  `searchAttributes` now ride the start-run path (`StartRunMessage` → `startRun` → the created run), so a
  tenant start carries the same queryable data a local start does. Store/driver-bound ops on a tenant
  worker (`cancel`/`deleteRun`/`resume`/`waitForRun`/`signal`/`signalWithStart`/`publishEvent`) throw a
  clear tenant error (the operator owns them). No app-facing `start_run` call is introduced.

## 0.5.0

### Minor Changes

- 52a3e67: Unified worker / one group — a much smaller surface for the "workflow + its steps" model.

  - **`engine.remote(name, { group })`** — convenience form of `registerRemote`: it builds the broker
    `RemoteWorkflowExecutor` for you, so a remote (e.g. polyglot/Python) workflow is one line instead of
    hand-wiring an executor. `registerRemote` stays as the low-level escape hatch.
  - **Steps inherit the workflow's group.** A `ctx.call` / `gather_calls` with no explicit group now
    dispatches to the **workflow's own group** (explicit group still wins). This is what lets a workflow
    and its steps collapse onto ONE group / ONE worker — no more "two groups for one workflow". The two
    recon facts that make this cheap: workflow turns and step calls already share one queue
    (`<prefix>-tasks-<group>`, job-name discriminated), and the worker runtime already routes both.
  - **`@Step` decorator** (NestJS) — `@DurableStep` is renamed to `@Step` (kept as a deprecated alias),
    aligning the name with the Python `@worker.step`. `@Workflow` unchanged.
  - **Adaptive concurrency measures only steps.** With one worker carrying both turns and steps on a
    single pool (correct — turns suspend, they don't block), the adaptive controller's latency/throughput
    window now counts only step completions, so a fast workflow turn can't corrupt the gradient.
    `AdaptiveController.onSettle` gains a `kind: 'workflow' | 'step'` argument.

  The Python `durable-worker` client gains the matching unified `Worker` (one worker holds both
  `@worker.workflow` and `@worker.step` on one group; `WorkflowWorker` kept as a deprecated alias for the
  opt-in split). Released separately (0.16.0). See `docs/workers-when-to-use.md`.

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
