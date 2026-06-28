# Workers, fan-out & concurrency — when to use what

This guide explains the two kinds of worker, the three ways to fan work out, and how to control
parallelism. The recurring source of confusion ("why two workers/groups?", "why did my parallel
fan run serially?") is answered here.

## The two worker types

A durable run is two different kinds of task, on two different queues:

| Task | Queue | Consumer | What it does |
|------|-------|----------|--------------|
| **Workflow turn** | `<prefix>-tasks-<workflowGroup>` | **WorkflowWorker** (TS) / `WorkflowWorker` (py) | Replays the workflow body to a *decision* (dispatch these steps / start these children / suspend). Short, orchestration-only. |
| **Step call** | `<prefix>-tasks-<stepGroup>` | **step `Worker`** (`@DurableStep` / `worker.step`) | Runs the actual handler (the heavy DB/CPU/IO work) and returns a result. |

They are **separate consumers on separate groups** because they are different task types. A single
consumer on one queue can't tell a workflow turn from a step call, so each needs its own group.

> If you use **remote steps** (`ctx.call` / `ctx.gather_calls`), you MUST run a step worker on the
> step group — otherwise the dispatched calls sit in the queue with nobody to run them and the run
> never progresses.

## Three ways to fan work out

Say a workflow needs to run N handlers. Pick by the trade-off you want:

### 1. `ctx.step` (local) — simplest, in-turn, serial
The handler runs **inside the workflow turn**, in the workflow worker's process. One worker, one
group, no step group needed. Recorded as a `local` step.

- ✅ Simplest; no second worker.
- ❌ Runs **inside replay** → serial, and a re-drive re-runs the whole turn from the last
  checkpoint (no per-handler isolation). Use for cheap, deterministic, sequential work.

### 2. `ctx.gather_children` — N child runs, 1 group
Fans into N **child workflow runs**, each a real durable run. Unregistered children inherit the
parent's remote group, so the **same workflow worker** consumes them — **one group**.

- ✅ One group; each child is independently durable & retryable.
- ❌ Creates a nested `child` run per handler (extra runs in the tree / dashboard). Good when each
  unit is genuinely its own *workflow* (has its own steps/children).

### 3. `ctx.gather_calls` — N remote steps, flat, needs a step group
Fans into N **remote steps** dispatched to a **step group**, recorded **flat** on the parent run
(same `parallelGroup`). Requires a step `Worker` on that group (the **second worker**).

- ✅ Flat (no child-run wrappers), independently checkpointed per handler, runs on a **scalable
  worker pool**, can run **in parallel** (see concurrency below).
- ❌ Needs the second group/worker. Best when handlers are leaf work (a function), not sub-workflows.

**Rule of thumb:** leaf handlers you want flat + parallel → `gather_calls`. Each unit is its own
workflow → `gather_children`. Cheap sequential work → `ctx.step`.

## Concurrency — why a "parallel" fan can still run serially

`gather_calls` makes the **dispatch** parallel: all N calls are enqueued at once. But how many run
**at the same time** is the **step worker's concurrency**, which defaults to **1** (BullMQ default).
So with one step worker at concurrency 1, the N steps execute **one at a time** — the total ≈ the
*sum* of the handlers, not the *max*.

Raise it with the `concurrency` knob (same name on every SDK):

```python
# Python
steps = Worker(group="...-handlers", concurrency=7)   # run up to 7 handlers at once
run_workers([workflows, steps], redis=redis_url)
```

```ts
// Node SDK (@dudousxd/durable-worker)
await runRedisWorker({ runtime, group, connection, concurrency: 7 });

// BullMQTransport (engine-side / default NestJS worker role)
new BullMQTransport({ connection, group, concurrency: 7 });

// NestJS in-app worker
DurableWorkerModule.forRoot({ connection, groups, concurrency: 7 });
// or per-group:
DurableWorkerModule.forRoot({ connection, groups, concurrencyByGroup: { 'foo-handlers': 7 } });
```

Total parallelism = `concurrency × worker replicas`. So you scale either by raising `concurrency`
on one process or by running more step-worker replicas (or both).

### Adaptive concurrency — let the worker tune itself

A fixed number is a guess: too low wastes the pool, too high stampedes RAM or a downstream DB. Pass
`'adaptive'` (or an object to override the defaults) instead of a number and the worker self-regulates:

```python
# Python
steps = Worker(group="...-handlers", concurrency="adaptive")
# or: concurrency={"min": 1, "max": 16, "ramCeilingPct": 85}
```

```ts
// any TS surface
new BullMQTransport({ connection, group, concurrency: 'adaptive' });
await runRedisWorker({ runtime, group, connection, concurrency: { mode: 'adaptive', min: 1, max: 16 } });
DurableWorkerModule.forRoot({ connection, groups, concurrencyByGroup: { 'foo-handlers': 'adaptive' } });
```

How it decides (same on both SDKs), every `tickMs` (default 2s):
- **Latency gradient (the main signal).** Compares recent p50 against the best (no-queuing) latency
  it's seen. Gradient near 1 = no queuing → **grow by 1**, but *only while saturated* (in-flight near
  the limit), since raising a ceiling nobody hits does nothing. Gradient dropping = latency inflating
  = queuing → **shrink** proportionally. Latency is bottleneck-agnostic — it catches a slow DB, CPU
  saturation, or lock contention without naming which.
- **RAM ceiling (hard brake).** Reads RSS against the cgroup `memory.max` (falls back to host total).
  Past `ramCeilingPct` (default 85%) it multiplicatively cuts the limit and refuses to grow — OOM is
  fatal and sudden, so it's a brake, not a gradient input.
- **Backpressure.** A burst of errors or a stall (in-flight > 0 but nothing completing) shrinks the
  limit. `cpuCeilingPct` is an optional extra cap (off by default — the latency gradient already
  subsumes CPU for I/O-bound work).

Bounds are `[min, max]` (defaults 1 and 32); it starts at `start` (default `min`). Adaptive is
**per process** — it protects *that pod*. A shared dependency (one RDS behind many pods) still needs a
global cap (`registerQueue`, below), and pod-count scaling is KEDA's job (watch the queue depth).

### Seeing what the workers are doing (Telescope)

Both adaptive and fixed workers publish a live **status** on their heartbeat — current concurrency /
adaptive limit, in-flight vs limit, queue depth, RAM %, CPU %, throughput, p95 latency, and (adaptive)
the last limit change with its reason. The durable **Telescope** dashboard renders this in a "Workers"
panel (one row per live worker), and the embedded dashboard's worker chips expand to the same
per-worker breakdown. For an adaptive worker this is how you *trust* the auto-tuner: you can watch the
limit move and see **why** it last backed off (`ram_ceiling` / `backpressure` / `shrink`).

### Capping vs increasing — two different knobs
- **To go faster (parallelise the fan):** raise the **worker `concurrency`** (consumer side, above).
- **To go slower (protect a dependency):** use the engine's durable **admission queue** —
  `engine.registerQueue({ name, limit, rateLimit })` + `ctx.call(step, { queue })` — which caps how
  many steps of a logical "channel" are in flight at once (durable, survives crashes). That's for
  *limiting* (e.g. "≤5 concurrent calls to a rate-limited API"), not for speeding a fan up.

## TL;DR
- Two workers/groups exist because **workflow turns** and **step calls** are different task types.
- `gather_calls` dispatches in parallel but executes at the **step worker's `concurrency`** — set it
  (default 1) or your parallel fan runs serially.
- `concurrency` (faster) and `registerQueue` admission (slower/cap) are opposite knobs.
