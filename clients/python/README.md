# durable-worker (Python)

Run [`nestjs-durable`](../../README.md) workflow steps in Python. A TypeScript workflow dispatches
a step by name with `ctx.step("payments.charge-card", input)` (or by reference for a same-runtime
`@Step`); the orchestrator dispatches it over the transport; a Python worker registered for the
same step **name** runs it and returns the result. One workflow, steps split across languages.

```python
from durable_worker import Worker, FatalError

worker = Worker()

@worker.step("payments.charge-card")
async def charge(data):
    res = await stripe.charge(data["orderId"], data["amountCents"])
    return {"chargeId": res.id}

# worker.run(transport=...)  # see "Transports" below
```

The handler's argument is the step **input** (already schema-validated by the engine); its
return value is the step **output**. Raise `FatalError` for a non-retryable failure (e.g. a
declined card); any other exception is treated as retryable and the engine applies the step's
retry policy.

## Authoring workflows in Python (coordinator-driven)

The inverse of the above: instead of Python *implementing a step* a TypeScript workflow calls,
Python can *author the whole workflow* and call back into NestJS. The NestJS engine stays the sole
owner of durable state, recovery and timers — it advances a run one **turn** at a time by sending
this worker the run's history; the worker **replays** the workflow function locally and returns the
commands it produced (call / record-step / sleep …), which the engine persists and dispatches. The
worker never touches a store, so it stays a pure function of the task (Temporal-style coordinator).

```python
from durable_worker import WorkflowWorker, redis_url_from_env

workflows = WorkflowWorker(group="py-workflows")

@workflows.workflow("pipeline")
def pipeline(ctx, base_id):
    started_at = ctx.now()                                          # replay-stable capture
    rows = ctx.step("ingestion", {"key": f"/{base_id}/data.csv"}, group="pipeline")  # dispatched
    ctx.sleep(60_000)                                                 # durable timer
    return {"rows": rows, "startedAt": started_at}

workflows.run(redis=redis_url_from_env())   # owns the loop, SIGTERM graceful close, Redis connection
```

The `WorkflowContext` ops are **deterministic** — same code + same history ⇒ same seqs ⇒ same
decisions:

| Op | Meaning |
| --- | --- |
| `ctx.step(name, input, group=...)` | Dispatch a step (routed by handler `name`, any language) and await its result. ALWAYS durable, ALWAYS engine-scheduled — one step primitive, no local/remote placement choice. |
| `ctx.now()` | A replay-stable wall-clock timestamp in epoch **milliseconds** (a number, like JS `Date.now()`) — captured once, replayed thereafter (instead of forcing a trivial capture through a dispatched step). |
| `ctx.side_effect(fn)` | The general deterministic-capture primitive (Temporal's `sideEffect`): run `fn` once, checkpoint its result, and replay the same value without re-running `fn`. Use for ids/random/env reads, e.g. `ctx.side_effect(lambda: str(uuid7()))`. |
| `ctx.sleep(ms)` | Durable timer — the run suspends and the engine resumes it when the timer fires. |
| `ctx.wait_signal(name)` | Block until a signal `name` is delivered to the run (via `engine.signal`); returns its payload. |
| `ctx.start_child(workflow, input)` | Start a child run and await its output (a failed child raises `StepFailed`). |

A step that fails raises `StepFailed` in the workflow — catch it to compensate (just like an
awaited rejection), or let it propagate to fail the run. Changing the workflow's op sequence under a
run already in flight raises `NondeterminismError` rather than silently diverging.

On the NestJS side, start `pipeline` by its name — the queue name is the routing, so whichever live
worker group serves `pipeline` picks it up:

```ts
await engine.start('pipeline', input);      // or `ctx.child('pipeline', input)` from another workflow
```

These ops are wired end-to-end — the engine executes the commands they emit (dispatched step,
replay-stable capture, durable timer, signal waiter, child run). `WorkflowWorker.process_task(task)
-> decision` is the pure, broker-free core (fully tested). The workflow-task/decision wire is
specified in
[`docs/plans/2026-06-15-polyglot-workflows-protocol.md`](../../docs/plans/2026-06-15-polyglot-workflows-protocol.md).

## Wire protocol

The contract between the orchestrator and a worker is plain JSON — language-agnostic, so a Go or
Rust worker can implement the same thing. The orchestrator dispatches a **task**:

```jsonc
{
  "runId":   "wrun_8Kb2",            // the workflow run
  "seq":     1,                       // deterministic step position
  "name":    "payments.charge-card",  // handler name (the contract)
  "stepId":  "wrun_8Kb2:1",           // stable id — use it to dedupe re-delivery
  "group":   "payments",              // worker group expected to handle it
  "input":   { "orderId": "o1", "amountCents": 4200 },
  "attempt": 1,
  "traceparent": "00-..."             // optional W3C trace context to continue the span
}
```

The worker replies with a **result**:

```jsonc
// success
{ "runId": "wrun_8Kb2", "seq": 1, "stepId": "wrun_8Kb2:1", "status": "completed", "output": { "chargeId": "ch_1" } }
// failure
{ "runId": "wrun_8Kb2", "seq": 1, "stepId": "wrun_8Kb2:1", "status": "failed",
  "error": { "message": "card declined", "code": "declined", "retryable": false } }
```

`Worker.process_task(task) -> result` is the pure core (no transport, fully tested). Idempotency
note: if the worker dies after running but before the result is recorded, the engine may
re-dispatch the same `stepId` — make handlers idempotent or dedupe on `stepId`.

## Transports

`process_task` is transport-agnostic. A transport adapter consumes tasks from the broker and
ships results back:

- **Redis / BullMQ** (`pip install durable-worker[redis]`) — `durable_worker.redis_runner`
  consumes the same Redis queues `@dudousxd/nestjs-durable-transport-bullmq` dispatches to:

  ```python
  import asyncio
  from durable_worker import Worker
  from durable_worker.redis_runner import run_redis_worker

  worker = Worker()

  @worker.step("payments.charge-card")
  async def charge(data):
      return {"chargeId": f"ch_{data['amount']}"}

  async def main():
      await run_redis_worker(worker)
      await asyncio.Event().wait()

  asyncio.run(main())
  ```

  This is wired end-to-end in [`scripts/py-e2e.sh`](../../scripts/py-e2e.sh): a TypeScript
  workflow's `ctx.step` runs this Python handler over Redis and gets the result back.
- **AWS SQS** (`pip install durable-worker[sqs]`) — `durable_worker.sqs_runner.run_sqs_worker`
  long-polls the same SQS queues the TS `SqsTransport` uses. Blocking loop; pass a
  `threading.Event` as `stop` to stop it.
- **SQL / Postgres / MySQL** (`pip install durable-worker[postgres]` or `[mysql]`) —
  `durable_worker.db_runner.run_db_worker` is broker-less: it claims task **rows** with
  `SELECT … FOR UPDATE SKIP LOCKED` from the same tables the TS `DbTransport` writes, runs the
  handler, and writes a result row. Implements the documented table + claim contract, so the two
  libraries share the schema. Requires Postgres 9.5+ or MySQL 8+.
- Bring your own: anything that can deliver a task dict and accept a result dict.

## Concurrency, and not being OOM-killed

`Worker(concurrency=N)` runs N tasks at a time. `concurrency="adaptive"` lets the worker tune that
number itself from a latency gradient, with a cgroup-aware memory brake — and, since 0.25, a
**memory admission gate**: before each step starts, the worker asks "is there room for one more
*right now*?" and **waits** instead of starting a step it cannot fit.

```python
worker = Worker(concurrency="adaptive")                 # gate on, all defaults
worker = Worker(concurrency={"min": 1, "max": 16})      # adaptive with bounds
worker = Worker(concurrency={"ramAdmission": False})    # gate off (pre-0.25 behaviour)
```

Why it exists: a worker whose handlers each build a few hundred MB (a DuckDB panel, a dataframe, a
model) can be handed N jobs of the same handler at once. The old brake only *reacted*, on a tick,
after the memory was already allocated — and it read `ru_maxrss`, the process **peak**, which never
falls, so it also stayed braked forever. Now:

- **Usage is current, not peak** — cgroup v2 `memory.current`, then cgroup v1
  `memory.usage_in_bytes`, then `/proc/self/status` `VmRSS`, and only as a last resort `ru_maxrss`.
  Reclaimable page cache (`memory.stat`'s `inactive_file`) is subtracted, giving the same "working
  set" kubelet evicts on — a worker that streams GBs through temp files is not braked for cache the
  kernel would simply drop.
- **The gate defers, it never rejects.** A waiting step keeps its job (BullMQ renews the lock), so a
  memory shortage never turns into a failed step. With **nothing in flight the gate always admits**,
  so a worker can't deadlock waiting for memory only it could free.
- **The brake is asymmetric.** Crossing `ramCeilingPct` drops the limit to `min` in one move (memory
  kills the process — you don't walk it down 20% a tick); growing back needs `growHeadroomTicks`
  consecutive ticks of real headroom.
- **Costs are learned per step name.** When a step runs alone the worker measures what it cost and
  reserves that much for the next one of that name, because usage at admission time does not yet
  include what an admitted step is about to allocate. The **first task of a process runs alone** so
  there is always one real measurement before anything runs in parallel.

| Knob (camelCase or snake_case) | Default | What it does |
| --- | --- | --- |
| `min` / `max` / `start` | `1` / `32` / `min` | Bounds and starting limit. |
| `ramCeilingPct` | `85` | Brake: at/above this, the limit collapses to `min`. |
| `ramAdmitPct` | `75` | Gate: above this, new steps wait. Clamped to `ramCeilingPct`. |
| `ramResumePct` | `65` | Hysteresis: once deferring, usage must fall under this to admit again. |
| `ramAdmission` | `true` | **Set `false` to turn the gate off entirely** (adaptive mode only knob). |
| `admissionPollMs` | `250` | How often a waiting step re-checks for headroom. |
| `admissionMaxWaitMs` | `0` | `0` = wait as long as it takes. Set a ms budget to cap the wait. |
| `growHeadroomTicks` | `3` | Consecutive ticks under `ramResumePct` required before growing. |
| `subtractPageCache` | `true` | Subtract reclaimable `inactive_file` from the cgroup charge. |
| `stepCostTracking` | `true` | Learn per-step-name costs and reserve them. `false` = usage-only gate. |
| `cpuCeilingPct` / `tickMs` | off / `2000` | Optional CPU cap; control-loop period. |

A **fixed** `concurrency=N` worker is never gated — N is your explicit promise — but it still
publishes the same memory numbers on its heartbeat.

Every heartbeat carries `status.rssBytes` / `rssPct` plus a Python-only `status.memory` block:
which source the numbers came from (`cgroup_v2_working_set`, `proc_vmrss`, …), the gate state
(`open` / `deferring`), how many steps are waiting, and what it has learned per step name. Telescope
and the dashboard render the shared fields; the extra block is visible in the raw heartbeat.

## Tests

```bash
python -m unittest discover -s tests
```
