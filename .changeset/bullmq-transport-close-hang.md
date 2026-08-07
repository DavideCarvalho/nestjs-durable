---
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

Stop `BullMQTransport.close()` from hanging forever on a wedged worker

A graceful BullMQ `Worker.close()` waits for the current job **and** for the blocking connection to be
released, and when the worker is still coming up — which is what a CPU-starved box produces — that
wait has no upper bound. Because the transport awaited those closes one after another and only ran
its `disconnect()` calls afterwards, a single wedged worker meant the remaining workers were never
asked to close, the Redis sockets were never dropped, and `close()` never resolved. Every caller
above it inherited that: in NestJS, `WorkflowRegistrar.onApplicationShutdown` → `app.close()`.

It is bimodal, not slow. In one measured run 20 transports closed in 4–46ms (median 5ms) and 3 sat in
`close()` for 120s, which was only where the probe stopped waiting.

`close()` now:

- races the graceful closes against a new `closeTimeoutMs` option (default `5_000`, `0` to skip the
  wait entirely);
- issues them concurrently instead of sequentially, so one wedge no longer blocks the others;
- always reaches the `disconnect()` calls, which is what actually lets the process exit.

Escalating to `close(true)` is deliberately not attempted: BullMQ memoizes the close promise
(`if (this.closing) return this.closing`), so a forced call after a graceful one returns the same
pending promise and forces nothing.

No behaviour change on a healthy close — it completes in single-digit ms, far inside the budget.
