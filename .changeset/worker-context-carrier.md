---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Dispatched work keeps its context carrier on the worker runtime.

- core: a dispatched workflow turn carries the engine's `context` carrier (`WorkflowTask.context`), as a dispatched step already did. `WorkflowExecutor.dispatch` takes an optional `{ context }`. The engine keeps the carrier it stamped on each turn in memory (bounded) and applies that turn's decision under it and in the run's tenant, so the steps and children the turn dispatches carry the same carrier. It never reads a carrier back from a worker; a decision applied by another instance, or after a restart, gets that engine's own context. A `rehydrate` that rejects the carrier is logged and the decision applied without it.
- worker: `new DurableWorkerRuntime({ rehydrate })` restores a dispatched turn's or step's carrier around its replay or handler, outside the durable execution wrappers (which now also receive `context` for a turn). A carrier `rehydrate` rejects fails the turn (a `failed` decision, `context_rehydrate_failed`, not retryable) or the step, instead of dropping it. The core peer floor rises to 0.107.0.
- nestjs: the auto-fed carrier is built with nestjs-context's `Context.serialize()` when its own accessor is bound, so the app's `carrier: [...]` allowlist decides what reaches the broker. The co-located and thin worker runtimes take the same `Context.deserialize` bridge the engine uses around a local step, when a context accessor is bound; what a handler sees is what your `deserialize` restores. Peer floors: `@dudousxd/durable-worker` 0.24.0, `@dudousxd/nestjs-durable-core` 0.107.0.
