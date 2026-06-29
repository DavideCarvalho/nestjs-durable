# Workers, fan-out & concurrency — when to use what

This guide explains the worker model, the three ways to fan work out, and how to control parallelism.

## One worker, one group (the default)

A durable run has two kinds of task — a **workflow turn** (replay the body to a *decision*: dispatch
these steps / start these children / suspend — short, orchestration-only) and a **step call** (run the
actual handler — the heavy DB/CPU/IO work). Both ride the **same queue** `<prefix>-tasks-<group>`
(distinguished by the BullMQ job name), and **one worker** consumes both and routes each internally.
So a workflow and its steps live on **one group, one worker**:

```python
# Python — one Worker holds the workflow AND its steps
worker = Worker(group="processing", concurrency="adaptive")

@worker.workflow("processing")
def processing(ctx, data): ...        # ctx.gather_calls([...]) — no group needed; inherits "processing"

@worker.step("handler")
def handler(data): ...

worker.run(redis=...)
```

```ts
// NestJS — @Workflow + @Step discovered onto one in-app worker (one group)
@Workflow({ name: "processing" }) class Processing { run(ctx, input) { ... } }
class Handlers { @Step("handler") handle(input) { ... } }

// Engine that delegates a remote (e.g. Python) workflow — one line:
engine.remote("processing", { group: "processing" });
```

A step with **no explicit group inherits its workflow's group**, which is what collapses everything
onto one group. (`@Step` is the NestJS step decorator; `@DurableStep` is a deprecated alias.)

> **Splitting is opt-in (advanced).** Put a step on a *different* group than its workflow (explicit
> `group`) and run a separate worker there to scale step execution independently of orchestration
> (e.g. a KEDA-autoscaled step pool). You give up the one-group simplicity for independent scaling.
> The Python `WorkflowWorker` (a workflow-only worker) still exists for this split.

> If you use **remote steps** (`ctx.call` / `ctx.gather_calls`), a worker must consume the step's
> group — by default that's the workflow's own group (handled by the unified worker above); only when
> you split does it become a separate group you must staff.

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

### 3. `ctx.gather_calls` — N remote steps, flat
Fans into N **remote steps** recorded **flat** on the parent run (same `parallelGroup`). The steps
inherit the workflow's group by default, so the **same unified worker** runs them — no second group
needed (unless you opt into the split for independent scaling).

- ✅ Flat (no child-run wrappers), independently checkpointed per handler, runs on a **scalable
  worker pool**, can run **in parallel** (see concurrency below).
- ❌ Best when handlers are leaf work (a function), not sub-workflows.

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
- **One worker, one group** by default: it consumes both workflow turns and step calls (same queue,
  job-name discriminated) and routes each. Steps with no explicit group inherit the workflow's group.
- Splitting workflow vs step onto separate groups/workers is **opt-in**, for scaling step execution
  independently of orchestration.
- `gather_calls` dispatches in parallel but executes at the worker's `concurrency` — set it (default 1,
  or `'adaptive'`) or your parallel fan runs serially. Adaptive measures **step** latency only.
- `concurrency` (faster) and `registerQueue` admission (slower/cap) are opposite knobs.

**See also:** [namespaces.md](./namespaces.md) — partitioning a shared store so multiple engines (e.g.
a dev cluster + a developer's laptop on the same DB) don't recover each other's runs.
