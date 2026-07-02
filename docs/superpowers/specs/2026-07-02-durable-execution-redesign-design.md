# Durable Execution Model + API Redesign — Design

**Date:** 2026-07-02
**Status:** Design — approved, ready for implementation plan
**Repo:** `@dudousxd/nestjs-durable` (core / nestjs / transport-bullmq / worker / Python `durable-worker`)

## Problem

The library exposes two ways to run durable work and forces the author to
name a `group` for the distributed one:

- `ctx.step(name, fn)` — a **local** durable step: runs `fn` in-process on the
  worker executing the turn, checkpoints the result.
- `ctx.call(remoteStepDef, input)` — a **remote** durable step: dispatched to a
  named `group` over the transport, run by any worker serving that group.

Every `@Workflow` is likewise **group-served**: its turns dispatch to a
`group`, and `DurableWorkerModule.forRoot({ groups: [...] })` starts one BullMQ
consumer per group. `RemoteStepDef.group` is a required field.

Two problems fall out of this:

1. **The local/remote split leaks into the mental model.** Authors must decide
   up front whether a unit of work is "local" or "remote" and learn two
   primitives, when the property they actually care about — *is it durable* —
   is true for both. Cross-service dispatch is the genuinely different case, but
   it's expressed as "same primitive, different field" rather than as the
   explicit exception it is.
2. **`group` is mandatory ceremony.** Neither Temporal (task queues default) nor
   Vercel/Inngest (no such concept) makes you name a pool for the common case.
   In this library you must, even when a single app serves every workflow it
   defines. `group` conflates two unrelated ideas: *which worker can run this
   handler* (a capability question — answerable from the handler registry) and
   *deliberate partitioning* (tenant, GPU, isolation — a real but rare need).

## Goals

- **One durable primitive for in-app work:** `ctx.step(name, closure)`, durable
  by default. This is already what `ctx.step` does — the redesign makes it *the*
  primitive and stops presenting `call` as its peer.
- **Cross-service as a named exception:** rename `ctx.call` → `ctx.remote`. Same
  mechanics (serializable I/O, dispatched to a handler registered in another
  runtime, workflow suspends), but named so its cost is visible.
- **Eliminate `group` from the common case** via handler-based routing: a worker
  subscribes to exactly the handlers it registered; the engine routes each
  workflow-turn / remote-step to a queue keyed by handler name. No app names a
  group to run its own workflows.
- **Keep partitioning available, opt-in:** a `partition` key (replacing
  group-as-pool) for deliberate isolation only — tenant, hardware, blast-radius.
  This is the one case Temporal keeps task queues for, and the one flip uses
  today (`pipeline@tenant`).
- **Reduce ctx surface:** the primary set becomes `ctx.step` · `ctx.remote` ·
  `ctx.sleep` / `sleepUntil` · `ctx.waitForSignal` / `waitForEvent`. Existing
  specialized primitives (`transaction`, `task`, `child`, entity ops,
  `continueAsNew`) are unchanged and out of scope.
- **Non-breaking migration path:** deprecation aliases, not a hard break, because
  flip + squid + Python consume this in near-lockstep.

## Non-Goals

- Rewriting the checkpoint/store format. The event log is the source of truth
  today and stays so.
- Touching `transaction`, `task`, `child`, `callEntity`/`signalEntity`,
  `continueAsNew`, webhooks, signals, events — surface stays as-is.
- Changing the dashboard / run-gateway / tenant topology shipped 2026-07-02.
- A codemod. Aliases make one unnecessary for the deprecation window; if a hard
  removal later wants one, that is a separate effort.

## Execution model: stateless replay-per-turn (the load-bearing decision)

The durable guarantee comes **entirely from the event log**, never from
in-process memory. This is made explicit as the model, resolving a tension in
the routing design.

- **The log is truth.** Every `ctx.step` / `ctx.remote` / timer / signal result
  is checkpointed to the store. Nothing else is durable.
- **Each turn is stateless.** A worker picks up a workflow-turn, **replays the
  workflow body from the top** against the log — completed steps return their
  recorded results (their closures do **not** re-run), fast-forwarding to the
  current frontier — runs the next step, persists it, and suspends. No workflow
  coroutine is held in memory between turns.
- **A dead pod is just another turn.** If a worker crashes mid-run, the next
  worker to pick up the run replays from the log identically. There is no
  special recovery path and no sticky affinity to lose.

**Why not keep the coroutine in memory (Temporal sticky) to skip replay?**
Because in-memory reuse requires **sticky routing** — the run's next turn must
return to the *same* worker — which directly fights handler-based routing (any
capable worker takes any turn) and adds a sticky-queue fallback mechanism. The
replay cost we avoid is cheap: replay re-executes only the **workflow body**
(deterministic orchestration glue), never the step closures (those return from
the log). For a workflow of N steps that is O(N) CPU-only reconstruction,
typically milliseconds. Vercel/Inngest run exactly this model at scale. We trade
a small per-turn replay for stateless workers, no sticky routing, and no
fragile in-memory state — strictly better for a pod-churning k8s deployment.

**Determinism requirement (unchanged, now load-bearing).** Because the body
replays every turn, all side-effects **must** live inside a `ctx.step` (or
`ctx.remote`/`transaction`/etc.) so their results are recorded and replayed.
Bare non-deterministic code in the body (`Date.now()`, random, I/O) re-runs on
every replay and breaks the invariant. This is why there is **no `localStep`**:
a non-durable inline step is either a side-effect (must be a `ctx.step` to be
replay-safe) or pure (just write it inline). There is no third case for it to
occupy.

## Routing: by handler, not by group

**Today:** one queue per group (`<prefix>-tasks-<group>`); both workflow-turns
and remote-steps land on it; a worker `new Worker(tasksName(group), …)` pops the
next job **blind** and only then looks up the handler by name. Mixed runtimes on
one group therefore collide — a Python worker pops a JS `pipeline` turn and fails
(and has already consumed the job).

**Redesign:** the queue key is the **handler name**, not a group.

- Each registered `@Workflow` and each remote `@Step` gets its own logical queue,
  derived from its name (e.g. workflow `pipeline` → its turn queue; remote step
  `extraction:page` → its step queue).
- A worker subscribes to **exactly the queues for the handlers it registered.**
  In NestJS this is derived by scanning the discovered `@Workflow`/`@Step`
  providers (the worker object is already implicit inside the lib — the app never
  writes `new Worker`). In Python the `Worker(workflows=[…], activities=[…])`
  object stays (no DI to scan) but derives its subscriptions from the passed
  lists instead of a `task_queue` argument.
- A worker never pops a job it can't handle, because it is not subscribed to that
  handler's queue. flip (registers `pipeline` + `extraction:page`) and Python
  (registers `processing`) can coexist with **no group** and never collide.

**`group` → `partition` (optional).** The pool-of-interchangeable-workers meaning
of `group` dissolves into per-handler routing. What remains is *deliberate*
partitioning, expressed as an optional `partition` key that suffixes the handler
queue (mechanically what `tenantGroup(group, tenant)` does today):

- Omitted → the bare handler queue (the common case; no ceremony).
- Present → `<handler>@<partition>`, and only workers started with that partition
  subscribe. This is tenant isolation (`pipeline@davi-local`), hardware pools
  (GPU workers), or blast-radius separation — chosen on purpose, with a reason.

This preserves flip's tenant story exactly (a tenant worker serves
`pipeline@<tenant>`) while removing the mandatory `group` for everyone who does
not need partitioning.

## API changes

### Core (`@dudousxd/nestjs-durable-core`)

- **`WorkflowCtx.remote(def, input, opts?)`** — new name for `call`, identical
  signature and semantics. `call` retained as a `@deprecated` alias delegating to
  `remote` (removed next major).
- **`RemoteStepDef.group` → `RemoteStepDef.partition?` (optional).** The step's
  routing queue is its `name`; `partition` (when set) suffixes it. A `group`
  field on the def is accepted as a `@deprecated` alias for `partition` for one
  minor cycle and mapped through with a one-time warning.
- **`remoteStep({ name, input, output, partition? })`** — `group` no longer
  required; accepted-and-mapped-to-`partition` deprecated for the window.
- Engine dispatch/consumption keys queues by **handler name (+ optional
  partition)** instead of group. `remoteByConvention` (route an unregistered
  workflow to a live group matching its name) becomes route-by-handler-name and
  keeps working for the tenant/operator split.

### NestJS (`@dudousxd/nestjs-durable`)

- **`DurableWorkerModule.forRoot({ … })`**: `groups: string[]` becomes optional;
  when omitted the worker subscribes to the queues for every discovered
  `@Workflow`/`@Step`. Replaced by an optional `partition?: string` (the current
  `tenant` field is re-expressed as `partition`, keeping `tenant` as a deprecated
  alias to avoid breaking the just-shipped tenant wiring). Per-group concurrency
  (`concurrency` / `concurrencyByGroup`) is re-keyed to handler/partition; the
  common single-value `concurrency` is unchanged.
- **`@Step` / `@Workflow`** decorators: no `group` needed. A `partition` option
  is available for deliberate isolation.
- The implicit worker (inside the module) subscribes per registered handler
  instead of `new Worker(tasksName(group))` once per group.

### Transport (`@dudousxd/nestjs-durable-transport-bullmq`)

- **Queue naming:** add a handler-keyed name — `<prefix>-h-<handler>` (+
  `@<partition>` suffix when partitioned) — alongside the current group name.
  `dispatch` / `dispatchWorkflowTask` target the handler queue; the worker starts
  one BullMQ `Worker` per subscribed handler queue.
- The group-keyed `tasksName` is kept during the deprecation window so a mixed
  fleet (one repo migrated, one not) still interoperates on a shared partition.

### Python (`durable-worker`)

- `Worker(client, workflows=[…], activities=[…], partition=None)` — drop the
  `task_queue` argument; derive subscriptions from the registered lists; keep
  `partition` for isolation. `task_queue` accepted as a deprecated alias mapping
  to `partition`.

## Migration

Breaking-shaped, delivered non-breaking via a one-minor deprecation window:

1. **Minor N (this work):** ship `ctx.remote`, `partition`, handler-based routing,
   and per-handler queues. Keep every old name as a `@deprecated` alias that maps
   through: `ctx.call`→`remote`, `RemoteStepDef.group`/`remoteStep({group})`→
   `partition`, `DurableWorkerModule` `groups`/`tenant`→partition-derived,
   Python `task_queue`→`partition`. Old and new queue names both live so a
   partially-migrated fleet interoperates. Emit one-time deprecation warnings.
2. **Consumers migrate independently** (flip, squid, Python) on their own
   schedule within the window — no lockstep, which is the whole point of aliases
   given the tenant work just paid the lockstep cost.
3. **Next major:** remove the aliases and the group-keyed queues.

## Testing

- **Core:** replay determinism (a workflow with steps + a `ctx.remote` replays to
  identical frontier after a simulated mid-run restart, closures run exactly
  once); `remote` and deprecated `call` produce identical dispatch; `partition`
  suffixes the queue and omission yields the bare queue.
- **Transport:** a worker subscribed to handler A does **not** consume a job for
  handler B on a shared partition (the collision this fixes); partitioned worker
  only consumes its `<handler>@<partition>` queue; group-keyed alias queue still
  interoperates during the window.
- **NestJS:** `DurableWorkerModule.forRoot({})` with no `groups` subscribes to
  exactly the discovered handlers; a two-runtime fixture (JS workflow + a stub
  "other-runtime" handler) sharing a partition never cross-consumes.
- **Regression:** the shipped tenant topology (operator + `pipeline@<tenant>`
  worker, run-gateway round-trip) still passes with `partition` in place of
  `tenant`/`group`.
- **Migration:** every deprecated alias resolves to its replacement and warns
  once; a fixture using only old names still boots and routes.

## Open questions

None blocking. Deferred to implementation:

- Exact handler-queue name format (`-h-<name>` vs another separator) — pick one
  that can't collide with an existing prefix; settle in the transport task.
- Whether `remoteByConvention` should warn when it routes by name to a partition
  it can't see a live worker for (observability nicety, not correctness).
