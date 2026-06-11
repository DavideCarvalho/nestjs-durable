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
- Bring your own: anything that can deliver a task dict and accept a result dict.

## Tests

```bash
python -m unittest discover -s tests
```
