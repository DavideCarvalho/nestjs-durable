# @dudousxd/nestjs-durable-transport-bullmq

## 0.12.0

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

- ecce3ca: Implement `dispatchStartRun` and `onStartRun` on `BullMQTransport` (P4). Messages are enqueued on `<effectivePrefix>-start-run`, respecting the existing namespace-prefix rule. Both methods follow the same BullMQ queue plumbing (`removeOnComplete`/`removeOnFail`, same JSON serialisation) as the existing tasks/results/decisions queues.
- b4b8b73: Tenant run gateway: a store-less tenant worker can now read (getRunDetail/listRuns), control
  (cancel/retry/continue/retryWithInput), and live-stream its OWN runs over the shared transport, via a
  new `RunGateway` port. The control plane binds a store-backed gateway and answers tenant requests —
  scoped to the tenant's namespace — over a new run-request queue plus run-reply and per-tenant-event
  pub/sub channels; a tenant binds a `ProxyRunGateway` (given an app-supplied transport). No store and no
  HTTP on the tenant side; every request is namespace-scoped so a tenant can never read or act on another
  tenant's run. `EngineEvent` now carries an optional `namespace` (stamped on `run.*` lifecycle events)
  so the control plane can re-publish a run's events to its owning tenant.

## 0.11.0

### Minor Changes

- 69ed5b1: feat: namespace now partitions the transport, not just the store

  A durable `namespace` already isolated the STORE (a worker only recovers/resumes/times-out runs in its
  own namespace). It now ALSO partitions the BullMQ TRANSPORT: every queue/stream/key name is derived
  from the namespace, so multiple logical deployments can safely share ONE Redis — a developer running
  locally against a shared Redis no longer collides with (or steals tasks from) the deployed workers, and
  vice-versa.

  - `BullMQTransport` gains a `namespace` option. All names (`<prefix>-tasks-<group>`, `-results`,
    `-decisions`, `-step-events`, the `-worker-heartbeat:` key, and the `-control` / `-heartbeat` channels)
    become `<prefix>-<namespace>-...` for a non-default namespace. A namespace that is unset or `"default"`
    → names are BYTE-IDENTICAL to before (production unchanged).
  - The engine propagates its own `namespace` to the transport via a new optional `Transport.useNamespace`,
    so you set the namespace ONCE on the engine. An explicit namespace passed to the transport's
    constructor still takes precedence.
  - The Python `durable-worker` gains a matching `namespace` param with the identical derivation
    (`prefix-namespace` for non-default), so a Python worker joins the same namespaced queues. Published
    separately as `durable-worker` 0.17.0.

  Pair the existing store `namespace` with this to get full two-axis isolation on shared infra:
  namespace → store, namespace-derived prefix → transport.

## 0.10.0

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

## 0.9.0

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

## 0.8.0

### Minor Changes

- f273457: Dispatch priority now reaches the broker, end-to-end.

  - `ctx.call(step, input, { priority })` and `ctx.child(workflow, input, { priority })` carry their
    priority onto the dispatched `RemoteTask` / `WorkflowTask`. The third arg of `ctx.child` /
    `ctx.startChild` accepts `{ childId?, priority? }` (a bare string is still shorthand for `childId`).
  - The BullMQ transport forwards that priority to the job's `priority` option, translating the
    engine's "higher = more urgent" scale onto BullMQ's inverse "lower = more urgent" so one convention
    holds end-to-end. Jobs without a priority keep the FIFO default path.
  - `WorkflowRun.priority` is persisted by every store adapter (MikroORM, Drizzle, TypeORM, Prisma) so
    the priority survives the store round-trip that precedes each remote-workflow advance. Additive,
    nullable column — auto-schema/self-heal adds it to existing tables.

## 0.7.0

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

## 0.6.0

### Minor Changes

- 4a9de4a: Live per-step observability for remote (polyglot) workflows. A Python `@workflow` runs its `ctx.step`s inline over a single turn that can last minutes, so previously the engine learned of the steps only when the turn ended — the dashboard showed "no steps yet" the whole run, and when they finally landed they had a 0ms duration and no sub-process trail.

  The worker now streams each local step's lifecycle as it happens, over a dedicated point-to-point `<prefix>-step-events` queue (a single engine instance consumes each event and checkpoints it once — no cross-pod duplicate writes):

  - **core**: `WorkflowStepEvent` + `Transport.dispatchStepEvent`/`onStepEvent`; the engine persists a `running` checkpoint when a step's body begins and resolves it to `completed`/`failed` with the step's real wall-clock window and its sub-process/log `events`. The turn's final `recordStep` command now also carries `startedAt`/`finishedAt`/`events` and `applyCommands` honors them, so the idempotent turn-end persist matches the live one (real duration, not 0ms).
  - **transport-bullmq**: implements `dispatchStepEvent`/`onStepEvent` over the `<prefix>-step-events` queue.

  Result: each handler step appears `running` the moment it starts, then `completed`/`failed` with a true duration and its p-processes shown under it — live, not all at once at the end.

## 0.5.0

### Minor Changes

- 00c4f5f: Worker-health observability: surface per-group queue backlog vs. live workers, so "a worker is alive but consuming nothing" stops being silent.

  - **transport-bullmq**: a worker stamps a TTL'd liveness heartbeat (`<prefix>-worker-heartbeat:<group>:<instance>`, refreshed every 10s / 35s TTL) while it's consuming — the key expiring is the signal it died or stalled. Mirrors the Python SDK's heartbeat key, so a mixed-language group reports all its workers together. Adds `groupHealth(group)` (queue depth via `getJobCounts` + live workers via a non-blocking `SCAN`) and `listWorkerGroups()` (discovers groups from the heartbeat keyspace).
  - **core**: `WorkerHeartbeat`/`GroupHealth` types + an optional `Transport.groupHealth`/`listWorkerGroups`. `WorkflowEngine.workerHealth()` aggregates health across the engine's registered groups (so a registered group with backlog and ZERO workers still reports — the alert case) UNION the groups discovered from live heartbeats (so a local-step group surfaces once its workers beat).
  - **dashboard**: a `/workers` API endpoint + a header "Workers" panel — one chip per group showing live-worker count and backlog, turning red on `depth > 0 && liveWorkers === 0`. The Prometheus `/metrics` scrape also emits `durable_group_queue_depth` and `durable_group_live_workers` gauges, so the same signal can drive an alert rule.

## 0.4.0

### Minor Changes

- 419facb: Carry remote workflows over the transport: `Transport.dispatchWorkflowTask` / `onDecision` (optional),
  implemented by `BullMQTransport` (dispatch a WorkflowTask on `<prefix>-tasks-<group>`, consume decisions
  on `<prefix>-decisions` — the queues the Python `durable-worker`'s `run_redis_workflow_worker` serves).
  New `RemoteWorkflowExecutor` implements `WorkflowExecutor` over a transport (correlates each turn's
  decision by `taskId`), so `engine.registerRemote(name, version, { group, executor })` drives a workflow
  authored in another SDK over Redis/BullMQ. Verified end-to-end live: a Python `WorkflowWorker` replays
  and the TS engine drives it across real Redis.

## 0.3.0

### Minor Changes

- e736e31: feat: BullMQ heartbeats over Redis pub/sub

  `onHeartbeat` is no longer a no-op: the BullMQ transport now carries worker heartbeats over a
  dedicated Redis pub/sub channel (`<prefix>-heartbeat`), mirroring the control plane. A worker calls
  `transport.heartbeat({ runId, seq, stepId, group })` while running a long step, and the engine — on
  any pod — resets that step's `timeoutMs` liveness window. (Only the in-memory `timeoutMs` path uses
  heartbeats; the durable-suspend path is unaffected.)

- 6836ace: refactor!: separate the control plane from the Transport

  `publishControl`/`onControl` are no longer part of `Transport`; they form a dedicated `ControlPlane`
  interface, and the engine takes a separate `controlPlane` dependency. This decouples cross-instance
  broadcast (lifecycle events + cancellation) from the point-to-point task transport, so you can run a
  dedicated control plane (e.g. Redis pub/sub) independent of how steps are dispatched. Broadcast-capable
  transports (event-emitter, BullMQ) implement `ControlPlane` too and can be passed as both; the NestJS
  module auto-wires the transport as the control plane when it qualifies, or accepts an explicit
  `controlPlane` option.

## 0.2.0

### Minor Changes

- **Transport control plane** — a broadcast pub/sub across all engine instances, unlocking the cross-pod features from the durability audit:

  - `Transport.publishControl(msg)` / `onControl(handler)` + a `ControlMessage` type. In-process transports (in-memory, event-emitter) broadcast locally; **BullMQ broadcasts over Redis pub/sub**. Optional — the engine degrades to local-only when a transport doesn't implement it.
  - **Cross-pod live-tail**: the engine now broadcasts lifecycle events, so a dashboard-only pod (`worker: false`) sees events from a run executing on a worker pod. The dashboard exposes `@Sse('runs/:id/stream')` and `durableClient.streamRun(id, onEvent)` — live updates without polling.
  - **Cooperative cancellation**: `engine.cancel(runId)` broadcasts the cancel; `engine.onCancel(fn)` lets a worker bridge abort in-flight work instead of finishing it just to have the result discarded. Events are deduped by originating `instanceId` so a broker echo doesn't double-deliver.
