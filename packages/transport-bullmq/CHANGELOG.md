# @dudousxd/nestjs-durable-transport-bullmq

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
