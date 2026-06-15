# durable-worker (Python)

Run [`nestjs-durable`](../../README.md) workflow steps in Python. A TypeScript workflow calls a
remote step with `ctx.call(chargeCard, input)`; the orchestrator dispatches it over the
transport; a Python worker registered for the same step **name** runs it and returns the result.
One workflow, steps split across languages.

```python
from durable_worker import Worker, FatalError

worker = Worker(group="payments")

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
    key  = ctx.step("setup", lambda: f"/{base_id}/data.csv")      # local step: runs once, recorded
    rows = ctx.call("ingestion", {"key": key}, group="pipeline")  # remote step: dispatched + awaited
    ctx.sleep(60_000)                                             # durable timer
    return {"rows": rows}

workflows.run(redis=redis_url_from_env())   # owns the loop, SIGTERM graceful close, Redis connection
```

The `WorkflowContext` ops are **deterministic** — same code + same history ⇒ same seqs ⇒ same
decisions:

| Op | Meaning |
| --- | --- |
| `ctx.step(name, body)` | Run a **local** step body once; its result is recorded, so `now`/`uuid`/a write happen exactly once and replay returns the captured value. |
| `ctx.call(name, input, group=...)` | Dispatch a **remote** step to a worker `group` (any language) and await its result. |
| `ctx.sleep(ms)` | Durable timer — the run suspends and the engine resumes it when the timer fires. |
| `ctx.wait_signal(name)` | Block until a signal is delivered to the run; returns its payload. *(engine support pending)* |
| `ctx.start_child(workflow, input)` | Start a child run and await its output. *(engine support pending)* |

A step/call that fails raises `StepFailed` in the workflow — catch it to compensate (just like an
awaited rejection), or let it propagate to fail the run. Changing the workflow's op sequence under a
run already in flight raises `NondeterminismError` rather than silently diverging.

On the NestJS side, register the remote workflow so the engine drives this worker's group:

```ts
engine.registerRemote('pipeline', '1', {
  group: 'py-workflows',
  executor: new RemoteWorkflowExecutor(transport),
});
```

`call` / `step` / `sleep` are wired end-to-end; `wait_signal` / `start_child` emit commands the
engine does not execute yet. `WorkflowWorker.process_task(task) -> decision` is the pure, broker-free
core (fully tested). The workflow-task/decision wire is specified in
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

  worker = Worker(group="payments")

  @worker.step("payments.charge-card")
  async def charge(data):
      return {"chargeId": f"ch_{data['amount']}"}

  async def main():
      await run_redis_worker(worker, group="payments")
      await asyncio.Event().wait()

  asyncio.run(main())
  ```

  This is wired end-to-end in [`scripts/py-e2e.sh`](../../scripts/py-e2e.sh): a TypeScript
  workflow's `ctx.call` runs this Python handler over Redis and gets the result back.
- **AWS SQS** (`pip install durable-worker[sqs]`) — `durable_worker.sqs_runner.run_sqs_worker`
  long-polls the same SQS queues the TS `SqsTransport` uses. Blocking loop; pass a
  `threading.Event` as `stop` to stop it.
- **SQL / Postgres / MySQL** (`pip install durable-worker[postgres]` or `[mysql]`) —
  `durable_worker.db_runner.run_db_worker` is broker-less: it claims task **rows** with
  `SELECT … FOR UPDATE SKIP LOCKED` from the same tables the TS `DbTransport` writes, runs the
  handler, and writes a result row. Implements the documented table + claim contract, so the two
  libraries share the schema. Requires Postgres 9.5+ or MySQL 8+.
- Bring your own: anything that can deliver a task dict and accept a result dict.

## Tests

```bash
python -m unittest discover -s tests
```
