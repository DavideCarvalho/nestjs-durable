---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Dispatched work keeps its context carrier on the worker runtime.

- core: a dispatched workflow turn carries the engine's `context` carrier (`WorkflowTask.context`), as a dispatched step already did. `WorkflowExecutor.dispatch` takes an optional `{ context }`. A `WorkflowDecision` may echo the turn's carrier (`context`), and the engine applies the decision inside it through its `rehydrate` bridge, so the steps and children that turn dispatches carry the same carrier.
- worker: `new DurableWorkerRuntime({ rehydrate })` restores a dispatched turn's or step's carrier around its replay or handler, outside the durable execution wrappers (which now also receive `context` for a turn). The worker echoes a turn's carrier on its decision. The core peer floor rises to 0.107.0.
- nestjs: the co-located and thin worker runtimes take the same `Context.deserialize` bridge the engine uses around a local step, when a nestjs-context accessor is bound. What a handler sees is what your `deserialize` restores, so an app that restores only the trace id keeps request authority out of durable work. Peer floors: `@dudousxd/durable-worker` 0.23.0, `@dudousxd/nestjs-durable-core` 0.107.0.
