---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

`ctx.localStep` on the worker runtime now honours `retries`, `backoff`/`backoffMs`/`backoffMaxMs`/`jitter` and `compensate`, as it does in-process. Both runtimes run the same retry loop (`retryLocalStep`, exported from core): `retries` is the total attempt count, attempts are spaced by `backoffDelay` with an in-process wait, a `FatalError` is not retried, and once attempts run out the step records the last attempt's error (its `code` and `details`) with the checkpoint's `attempts` set. A worker unwinds registered `compensate` closures in reverse when a turn fails, recording each as `compensate:<step>` at the engine's negative positions; `WorkflowWorker` and `DurableWorkerRuntime` take a `compensationRetries` option (default 1). The `recordStep` command carries an optional `attempts`, which the engine stores on the checkpoint (an older worker that omits it is recorded as 1). `DurableModule.forRoot({ compensationRetries })` now reaches the co-located and thin worker runtimes too. On the worker an unwind is at least once (its undo records ride the failed turn's decision), so compensations must be idempotent. `@dudousxd/durable-worker` now needs `@dudousxd/nestjs-durable-core` >= 0.105.0, the release that adds `retryLocalStep`.
