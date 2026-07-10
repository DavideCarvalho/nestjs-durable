# @dudousxd/nestjs-durable-dashboard

## 0.29.7

### Patch Changes

- da80cde: **Recover a remote step whose dispatched job was LOST.** A remote step with no `timeoutMs` dispatches
  its work, persists a `pending` checkpoint, and suspends until the result resumes it. If the worker
  crashed mid-step (no result) or the transport dropped the job (a Redis flush/eviction, or a stalled
  job moved to `failed` and removed), the result never came — and nothing re-dispatched it. Reconcile
  re-drives re-suspend a still-`pending` step by design, `recoverIncomplete` only reclaims leased runs,
  and the dashboard "retry" just replayed back to the same wait. So the run hung on `pending` forever.
  Four independent closes:

  - **`WorkflowEngine.redispatchPending(runId)` (core) + a "Re-dispatch" dashboard action** — the manual
    escape hatch: re-enqueues a run's stuck `pending` remote steps (bumping `attempts`) so the idempotent
    step re-runs and its result resumes the run. Exposed through `RunGateway` and over the tenant proxy.
  - **Opt-in self-heal `remoteRedispatchMs` (core)** — when set, a reconcile re-drive that finds a remote
    step still `pending` past this window re-dispatches it (a clock-space deadline stamped on the
    checkpoint, stable across replays), bounded by `remoteRedispatchMax` (default 10) so a step that never
    settles fails as a `remote_step_lost` error instead of looping. Off by default: re-dispatch can
    double-run a merely-slow step, so the window must exceed the longest such step and steps must be
    idempotent. Prefer a per-step `timeoutMs` where you can; this is the store-driven net for the
    no-timeout steps that must survive a lost dispatch.
  - **BullMQ transport bridges a terminal job failure (`transport-bullmq`)** — a crashed/stalled task job
    now publishes a synthetic failed `StepResult` (via `Worker.on('failed')`), so the engine marks the
    checkpoint `failed` and its normal durable retry re-dispatches — instead of the run hanging on
    `pending`. Requires retaining the failed job's payload briefly (`removeOnFail: { age }`) so the bridge
    can read the task identity before BullMQ GCs it. A handler business-error still succeeds the job (it
    already publishes its own failed result), so there is no double-publish.
  - **Stale-pending visibility (dashboard)** — a remote step `pending` past `STALE_PENDING_MS` (10 min) is
    flagged in the timeline ("awaiting worker result — dispatched Nm ago (possibly lost)") instead of
    masquerading as a healthy in-flight step, so an operator can see and re-dispatch it.

## 0.29.6

### Patch Changes

- fcf4925: **`no-worker` is now gated on a real queue backlog, not bare `liveWorkers === 0`.**

  A worker only heartbeats for a group while it's actively serving it, so an IDLE group — a suspended
  run parked on its reconcile timer with nothing enqueued, or a scheduled workflow between its cron runs
  — legitimately reports zero live workers even though nothing is blocked. The old check mislabelled
  those runs `no-worker` even when every step was complete and the run was simply waiting to be
  replayed/finalized.

  `deriveRunState` now flags `no-worker` only when a group is STALLED — `depth > 0 && liveWorkers === 0`,
  a backlog with no consumer (the alert condition `GroupHealth` itself documents). A parked/settled run
  with no backlog reads `running` (open, in flight) and flips to `no-worker` only once its resume
  actually enqueues with no consumer. This also corrects the header banner, which was counting
  completed-work orphans as stalled.

## 0.29.5

### Patch Changes

- 1175765: Follow-ups to the legible waiting-run states:

  - **List ↔ detail now agree.** The detail header derived its status from the timeline alone, so a run
    that had settled a step and was waiting for its workflow worker to advance showed `awaiting` in the
    detail while the list correctly showed `no-worker`. Both now use the same health-aware
    `deriveRunState` (the detail just also passes the `timeline` for step-level precision — an in-flight
    step reads `running` when its group has a worker, `no-worker` when it doesn't; a pending signal
    checkpoint reads `awaiting` named the same way as the list; a pending sleep reads `sleeping`). The
    graph's end node takes the same resolved status.
  - **Tenant shown.** A run's worker-pool partition (`namespace`) is shown as a chip in the list row and
    the detail header when it's a real named tenant (hidden for the single-pool `default`).
  - **English copy.** The no-worker banner and the singleton-queued label are in English
    ("Runs waiting on handlers with no live worker…", "behind leader …").

## 0.29.4

### Patch Changes

- fa75b51: Make a suspended run's WHY legible in the `/durable` dashboard. The engine keeps one generic
  `suspended` for every durably-parked run, so the list used to show one flat badge whether a run was
  waiting on a signal, blocked with no worker, or queued behind a singleton leader. Now:

  - **Waiting on what** — the control plane resolves each suspended run's event wait from its signal
    waiters (one bulk `listSignalWaiters` scan, no per-run timeline fetch) and names it in the list row:
    `signal <name>` / `webhook <token>` / `child <id>` (new `RunWaiting` on the gateway's `RunListItem`,
    classified by waiter-token prefix — `wh:` / `child:` / `event:` — via the new `classifyWaiterToken`).
  - **No worker** — a run whose handler has no live worker is flagged `no-worker` (joined against the
    Workers panel's health), with a header banner listing the stalled workflows, so "control plane up
    but nothing consuming the queue" is obvious at a glance instead of looking like a normal sleep.
  - **Queued behind a singleton** — runs sharing a `singleton:<key>` tag show the leader as running and
    the rest as `queued`, naming the leader — derived entirely client-side (the engine already stamps
    the tag), mirroring the admission order.

  All states re-derive on the existing poll, so they flip to `running` on their own the moment a worker
  rejoins or the leader settles. Deliberately event-only on the server (no timer/step guess): `wakeAt`
  alone can't tell a real `ctx.sleep` from the reconcile-fallback `wakeAt` an event/step suspend now
  carries, so a non-event suspend with a live worker shows as `running` rather than a misleading
  "sleeping" — the detail view (which has the timeline) still distinguishes them precisely.

## 0.29.3

### Patch Changes

- 59ac614: Make the pods inside the Workers panel's "+N" overflow popover click-to-expand, exactly like the visible pod chips: clicking a hidden pod's row now reveals the same detail (live status cells + the full list of handlers it serves) inline, instead of showing only its one-line summary. The shared body is factored into a `PodDetail` component so a pod behind "+N" and a visible chip reveal identical detail.

## 0.29.2

### Patch Changes

- 7f3e308: Workers panel: summarise in domain terms + styled tooltips + a clickable overflow.

  - **"N workflows · M steps"** replaces the raw "76 queues" in the alerts summary — deduped by base name across partitions, driven by the new `GroupHealth.kind` from the control plane. A hover tooltip explains route-by-handler and still shows the underlying queue count.
  - **Styled tooltips** replace the browser's native `title=` bubble on the pod, partition, starved, and summary chips — same dark surface as the panel's popovers, positioned below-right so they never clip the header edge, and suppressed while a chip's own click-popover is open.
  - **The "+N" overflow chip is now clickable**: it opens a popover listing exactly which pods it hides (instanceId · partition · handler count · load), instead of hiding them behind an unreadable multi-line `title`.

## 0.29.1

### Patch Changes

- 7c5ae39: Fix the Workers panel's "pods" view overflowing its fixed-width header slot and painting over the pods/parts/alerts toggle. With several live pods, the right-justified `flex-nowrap` row of chips (which must keep `overflow: visible` for the per-pod expand popover) grew far past the 300px slot and spilled left over the toggle. The row now caps to a couple of narrower chips and collapses the rest into a `+N` chip (full instanceIds in its tooltip), so it can never exceed the slot regardless of pod count.

## 0.29.0

### Minor Changes

- c27c276: The dashboard header now shows the deployment's durable **role** — "control plane" or "tenant · <partition>" — instead of a hardcoded "control plane" label (which was wrong on a tenant). `RunGateway` gains a synchronous `topology(): DurableTopology` (`{ role: 'control-plane' | 'tenant'; tenant? }`): the store-backed gateway reports `control-plane`, the `ProxyRunGateway` reports `tenant` with its partition name. Exposed via `GET /api/durable/topology` and rendered as a header badge (tenant highlighted amber). No round-trip — it's local metadata each gateway already holds.

## 0.28.0

### Minor Changes

- ccd7abc: The dashboard **Workers** panel now works on a tenant deployment. `workerHealth` moves onto the `RunGateway` port (joining the read/control verbs), so a store-less tenant proxies it over the transport instead of hitting the operator-only guard and throwing `This durable dashboard operation requires the control plane`. The `RunRequestResponder` — the tenant boundary — answers it scoped to the requester's own groups by the `<name>@<tenant>` queue convention, so a tenant only ever sees the health of ITS OWN queues, never another tenant's or the operator's bare groups. On the control plane the behaviour is unchanged (every group, unscoped). `metrics`/`getEvent`/`update`/`deliverWebhook` stay control-plane-only.

## 0.27.0

### Minor Changes

- 23325d3: Saga compensation for dispatched steps — `ctx.step(ref, input, { compensate })`.

  The undo is another `@Step` (a method reference, compile-checked to accept the
  `StepUndo<TInput, TOutput>` envelope of the call it undoes — see the new `UndoOf<H>` helper — or a
  name string for a cross-runtime handler, e.g. Python). On failure (or `cancel({ compensate: true })`)
  the engine dispatches the registered undos durably in reverse order, each called with the
  compensated step's `{ input, output }`.

  The whole unwind is now checkpointed at reserved negative seqs (`-1` = first undo executed): a crash
  mid-unwind resumes where it left off instead of re-running completed undos — this also applies to
  `ctx.localStep` closures, whose in-process retry semantics are otherwise unchanged. The
  `compensate:<step>` checkpoints make the saga visible in run detail; the dashboard renders them as
  an amber Compensation section with a `compensated`/`compensating` header chip and banner, and the
  client exports `splitCompensations`/`compensationSummary`/`compensationDisplayName` for consumers
  rendering their own timelines.

## 0.26.1

### Patch Changes

- 2737043: Dashboard polish: kill two layout shifts. The Workers panel toggle now swaps views inside a
  fixed-width, right-justified slot (`flex-nowrap`), so switching between pods/parts/alerts no longer
  wraps the header onto a second line or jumps its width. The runs list shows a skeleton while the
  first `/runs` fetch is in flight instead of flashing "No runs yet." before real data lands.

## 0.26.0

### Minor Changes

- 1de45da: Rework the `/durable` Workers panel into three toggleable views. After route-by-handler,
  every `@Step`/`@Workflow` became its own queue, so the old panel showed one chip per handler
  and buried the fact that a single worker pod serves dozens of them. The panel now defaults to a
  **by-pod** view (one chip per live worker instance, with its partition, handler count, in-flight
  saturation, and adaptive-concurrency status) and offers **by-partition** and **health-first
  (starvation alerts)** views via a toggle. The alerts toggle surfaces a red count badge whenever a
  served queue has depth but no live workers.

## 0.25.0

### Minor Changes

- 45c7d75: Topology-agnostic dashboard: `DashboardService` run views/control/stream now route through the `RUN_GATEWAY` port, so a store-less tenant can mount the same `DurableDashboardModule` the operator uses (backed by `ProxyRunGateway`). `RunGateway.cancel` gains an optional `compensate` opts; `DurableWorkerModule` is now `global` so a globally-mounted dashboard resolves `RUN_GATEWAY` on a tenant. Operator-only operations (metrics, worker health, webhook delivery, live event read, update delivery) require the control plane and throw a clear error on a tenant.

## 0.24.0

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

## 0.23.2

### Patch Changes

- de1dfdc: Run-detail graph: single-step child runs (e.g. `ctx.gather_children` handler wrappers) now render collapsed as their lone inner step — named directly (`handle_AF_FLEET`), one level, with the inner step's status/duration/sub-counts. No more generic "child workflow" node to expand to reach the handler, and the fan reads as the handlers themselves. The `child ↗` affordance is kept; only the (now pointless) inline-expand chevron is hidden. Visible children are fetched eagerly so the collapse also applies when viewing the parent run with a child expanded.

## 0.23.1

### Patch Changes

- a2a6350: Stack parallel-fan steps vertically in the run-detail workflow graph. The `WorkflowGraph` (ReactFlow) laid every step out left-to-right and chained them with solid main-flow edges, so a `ctx.gather`/`ctx.all` fan-out — N siblings the engine tags with the same `parallelGroup` (e.g. a `processing` run's 7 `handle_*` handlers, or a `Promise.all` of `ctx.child` siblings) — rendered as a misleading horizontal `start → s1 → … → sN → end` chain, reading as if each step spawned the next. The graph now reuses `groupParallelSpans` (already powering the spans gantt) and lays each fan's members in a single column, stacked one below the other, with `start`/previous step fanning OUT to every member and every member fanning IN to whatever follows — so concurrent steps read as concurrent, not as a parent→child sequence. Sequential steps are unchanged.

## 0.23.0

### Minor Changes

- c1aaacd: Add a transient `cancelling` run status so a compensating cancel is visible (and durable) instead of looking like a still-`running` run.

  **core:** `RunStatus` gains a non-terminal `'cancelling'`. `cancel(runId, { compensate: true })` now persists `cancelling` immediately (and returns it) while the background saga undo runs, then flips to `cancelled` — previously the run stayed `running`/`suspended` with no outward signal that a cancel was in flight. A repeat compensating cancel is idempotent. The status is treated as in-flight everywhere it must be: the singleton admission gate counts it, and recovery re-drives it — so a crash mid-compensation re-derives the cancel intent from the persisted status and finishes the cancel (a compensating cancel is now crash-durable). A non-compensating `cancel()` is unchanged (straight to `cancelled`). For a remote/polyglot workflow (no TS-side compensations) a `cancelling` run finalizes deterministically to `cancelled`.

  **stores (mikro-orm / typeorm / prisma / drizzle):** `listIncompleteRuns()` now also returns `cancelling` runs so recovery re-drives a compensation interrupted by a crash. Columns are free strings — no migration.

  **dashboard / telescope:** render `cancelling` with a distinct in-progress amber (it pulses like a live run; distinct from the grey terminal `cancelled`), add it to the status filter and the state-breakdown chart.

  **codegen:** generated run-status union types include `'cancelling'`.

## 0.22.4

### Patch Changes

- 1d76da7: Migrate all internal consumers (engine factory, registrars, timer poller, dashboard service, telescope data providers) to the canonical capability tokens, and flip the dual-bind so the canonical token (`@dudousxd/nestjs-durable:state-store`/`:transport`/`:options`) is the real provider while the legacy `nestjs-durable:*` tokens become `useExisting` back-compat aliases. The legacy tokens are now `@deprecated` but still resolve to the same instances — fully non-breaking.

## 0.22.3

### Patch Changes

- d0ff566: Ship the dashboard server build as dual ESM + CJS (was ESM-only), matching every other package in
  the ecosystem.

  The server entry was compiled with `tsc` to ESM only, and `package.json#exports` exposed just an
  `import` condition. A CommonJS host (e.g. a NestJS app built with `nest build` → CommonJS) that
  `require`s this package would load the ESM build, while it `require`s `@dudousxd/nestjs-durable` as
  CJS. ESM and CJS are separate module instances, so the dashboard pulled a SECOND copy of
  `@dudousxd/nestjs-durable-core`. The DI symbol tokens survive that split (they're `Symbol.for`), but
  `WorkflowEngine` — a class used as an injection token — does not: each core copy exposes a distinct
  class object, so `DashboardService`'s `WorkflowEngine` (and `STATE_STORE`) no longer matched the
  providers exported by `DurableModule`, and boot failed with `Nest can't resolve dependencies of the
DashboardService (?, WorkflowEngine) ... in the DurableApiModule module`. App-internal test runners
  (Vitest/swc) load everything as one module system, so this only surfaced in built CJS apps.

  The server now builds through the shared decorator-aware tsup config (dual format, SWC so DI
  metadata survives), `import.meta.url` is shimmed in the CJS output (the UI controller uses it to
  locate the bundled SPA), and `exports["."]` gains a `require` condition. A CJS host now resolves the
  dashboard — and therefore core — in the same module system as the rest of the durable packages, so
  they share one `WorkflowEngine`. No API change. The `./client` (browser) entry stays ESM.

## 0.22.2

### Patch Changes

- de857de: Polish the dashboard: a proper SVG brand mark (a workflow glyph) replaces the bare `◆` in the header and the empty state. The spans waterfall now sizes every bar by the window that matches the rest of the UI — a child-ref step uses the child run's full window (no more 0ms on an awaited child), a fan-out step uses its sub-process span (min start → max end) — and each sub-process row shows its own duration. Bars animate smoothly (CSS width transition) as live durations grow.

## 0.22.1

### Patch Changes

- 7bb830e: Child nodes/rows read the child's real workflow name (fetched for every visible child), not the raw `signal:child:<id>` / `spawn:<id>` checkpoint name — in both the graph and the spans waterfall. The spans waterfall now sizes each bar by the step's own `[startedAt, finishedAt]` window (a true gantt) instead of the inter-checkpoint gap, so a bar's width is the step's real duration and waits between steps read as gaps.

## 0.22.0

### Minor Changes

- 70a14a8: Deep-link the open run and let nested child steps open their detail.

  - The open run is now stored in the URL hash (`#/run/<id>`) — reload-safe and shareable; back/forward navigates run history.
  - Clicking a step **inside an expanded child sub-flow** (graph node or spans row) now opens its detail panel, rendering from the child run it belongs to (not only the root run's timeline). Selection is keyed by `runId#seq` across lanes.

## 0.21.0

### Minor Changes

- e5451e1: Expand a child workflow inline **in the React Flow graph**. A child-workflow node now has an expand chevron (next to its `child ↗` badge); expanding renders the child run's whole flow as a lane below the parent, recursively (grandchildren get deeper lanes). An awaited child (`ctx.child`) rejoins the parent — its last step links into the parent's next node via a dashed branch — while a fire-and-forget child (`ctx.startChild`) branches below without rejoining. The step-detail panel also gains an inline child-run waterfall (and an "open ↗" link), so you can drill into a child without leaving the run.

## 0.20.2

### Patch Changes

- 26bab70: Keep an awaited child workflow attached to its parent after it finishes, and stop a child node-click from navigating away.

  - **core:** `getRunChildren` now discovers an awaited `ctx.child` from the persisted `signal:child:<id>` checkpoint, not only the live `child:<id>` signal waiter. The waiter is consumed the instant the child settles, so a completed parent (or completed child) used to drop out of the parent→children tree — making an inline child view vanish the moment its work finished. The checkpoint persists across completion, so the edge is now stable for finished runs too.
  - **dashboard:** clicking a child-workflow node (graph) or row (spans) now opens its step detail like any other step, instead of immediately navigating to the child run. Navigating is the dedicated `child ↗` badge's job — so you can inspect a child step (and inline-expand it) without leaving the run.

- 26bab70: Re-export `groupSubProcesses` (and the `SubProcess` type) from the `./client` entry. External consumers embedding the timeline (e.g. flip's `pipeline-runs` view) can now reconstruct a step's sub-processes the exact same way the dashboard does — grouping by run identity (`subId`/`name`) and treating `phase` events as a sub-process's lifecycle — instead of re-implementing it against the deprecated `process` tag and dropping `phase` events into a flat log list.

## 0.20.1

### Patch Changes

- b8f8ebb: Re-export `groupSubProcesses` (and the `SubProcess` type) from the `./client` entry. External consumers embedding the timeline (e.g. flip's `pipeline-runs` view) can now reconstruct a step's sub-processes the exact same way the dashboard does — grouping by run identity (`subId`/`name`) and treating `phase` events as a sub-process's lifecycle — instead of re-implementing it against the deprecated `process` tag and dropping `phase` events into a flat log list.

## 0.20.0

### Minor Changes

- 16419df: `/durable` spans panel UX: the spans panel is now **user-resizable** (drag the divider above it; clamped so neither the graph nor the spans collapse to nothing), and each step's **sub-process waterfall is collapsible** (a chevron per fan-out step hides/shows its p-process rows — handy when a step fans out into dozens).

## 0.19.0

### Minor Changes

- 00c4f5f: Worker-health observability: surface per-group queue backlog vs. live workers, so "a worker is alive but consuming nothing" stops being silent.

  - **transport-bullmq**: a worker stamps a TTL'd liveness heartbeat (`<prefix>-worker-heartbeat:<group>:<instance>`, refreshed every 10s / 35s TTL) while it's consuming — the key expiring is the signal it died or stalled. Mirrors the Python SDK's heartbeat key, so a mixed-language group reports all its workers together. Adds `groupHealth(group)` (queue depth via `getJobCounts` + live workers via a non-blocking `SCAN`) and `listWorkerGroups()` (discovers groups from the heartbeat keyspace).
  - **core**: `WorkerHeartbeat`/`GroupHealth` types + an optional `Transport.groupHealth`/`listWorkerGroups`. `WorkflowEngine.workerHealth()` aggregates health across the engine's registered groups (so a registered group with backlog and ZERO workers still reports — the alert case) UNION the groups discovered from live heartbeats (so a local-step group surfaces once its workers beat).
  - **dashboard**: a `/workers` API endpoint + a header "Workers" panel — one chip per group showing live-worker count and backlog, turning red on `depth > 0 && liveWorkers === 0`. The Prometheus `/metrics` scrape also emits `durable_group_queue_depth` and `durable_group_live_workers` gauges, so the same signal can drive an alert rule.

## 0.18.0

### Minor Changes

- 95cc4c1: Dashboard: child workflows can now be expanded inline in the spans view — a child step nests the
  child run's spans beneath it (recursively), so you can drill into child workflows without leaving
  the parent run. The "open ↗" affordance still opens the child's full run view.

## 0.17.1

### Patch Changes

- 777cc82: fix(dashboard): stop sub-processes flickering on in-flight runs

  The 1.5s poll (and lifecycle invalidations) refetched a still-running step with empty `events` — the
  store only persists a step's events at completion — and React Query replaced the cache, wiping the
  trail the live `step.progress` stream had appended. Sub-processes appeared, vanished, then reappeared
  on the next stream event. The run query now merges over the cache (`mergeLiveEvents`): an in-flight
  step keeps its streamed events, while a completed/failed step's fetched events stay authoritative.

## 0.17.0

### Minor Changes

- dcc97fd: Make in-flight local steps visible. A local `ctx.step` now announces its body has started — emitting a `step.started` lifecycle event and (by default) persisting a `running` checkpoint — so a long-running step shows up in the dashboard the moment it begins, not only once it completes. Previously a local step was checkpointed only on completion, so an in-progress step was invisible.

  - New checkpoint status `'running'` for a local step whose body is executing in-process. It's a placeholder overwritten by `completed`/`failed`, and never short-circuits replay (only `completed` does), so a crash mid-body simply re-runs the step.
  - New engine option `trackStepStart` (default `true`). The `step.started` event always fires (the live SSE view sees the start regardless); the flag gates only the extra `running` checkpoint write. Set it to `false` on hot paths with many short local steps to halve their checkpoint writes — at the cost of reload-survivable in-flight visibility.

- 63b0d09: Extensible sub-process model: `StepEvent` gains optional `subId` (run identity), `group`, and `phase`
  fields, and `StepLogger` gains `subEvent()` for emitting per-sub-process phase transitions and a
  terminal outcome. The dashboard renders each sub-process as an expandable lifecycle row (phases,
  duration, status, error, owned logs) grouped by run identity. The existing `sub(name, status)` is
  unchanged.

## 0.16.0

### Minor Changes

- f884452: Refine a suspended run's displayed status by _why_ it's parked, instead of the catch-all `suspended`.

  The engine stores one generic `suspended` for every durably-parked run (it drives recovery, timers
  and queries — unchanged). But to a human those situations read very differently, so the dashboard now
  derives a display status (`runDisplayStatus`): a run whose remote step a worker is executing right now
  shows as **running**, a durable sleep as **sleeping**, and a wait on a signal as **awaiting**. The run
  badge (list + detail) and the workflow graph's end node all use it. No engine/store change — purely
  how the open run is labelled, so "a step is running but the run says suspended" stops being confusing.

## 0.15.0

### Minor Changes

- e149ec6: Live step progress + per-sub-process log grouping, and a dashboard layout fix.

  - **`step.progress` events**: a running step's log lines / sub-process outcomes are now emitted as
    `step.progress` engine events as they happen (not only batched onto `step.completed`). They ride
    the control plane like any lifecycle event, so the dashboard tails a long step line-by-line. The
    dashboard merges each one into the cached run instead of refetching (no store round-trip per line —
    and the store only has the events at completion anyway). `EngineEvent` gains an optional `event`.
  - **`StepEvent.process`**: a log line emitted inside a sub-process can carry that sub-process's name,
    so the step detail panel groups a fan-out step's trail per sub-process instead of one flat list.
  - **Dashboard layout**: the run-detail spans panel no longer collapses the WorkflowGraph to 0px. Its
    height now lives in the grid track (`1fr clamp(...)`); as an `auto` row it sized to the (tall) span
    content's min-content and stole the whole grid.

  The Python worker client (`durable-worker`) gains the matching `StepContext.process(name)`, an
  `on_event` sink on `process_task`/`aprocess_task`, and live `step.progress` publishing from the Redis
  runner — released separately on its own version.

- a0adc71: Dashboard polish: fix-and-replay, run tree, more metrics.

  - **Fix-and-replay**: `engine.retryWithInput(runId, input)` re-runs a dead/failed run with a corrected input as a fresh linked run (the original stays inspectable). The dashboard run detail gets a **"Fix & replay"** button (edit the input JSON, re-run) for dead/failed runs.
  - **Run tree**: the run detail now lists the run's **children** (`ctx.child` / `ctx.startChild`), clickable to navigate the parent→children tree.
  - **Metrics**: `/metrics` adds a `durable_running_runs` gauge (alongside the `durable_pending_runs` backlog + `durable_dead_runs` DLQ-size gauges).

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
