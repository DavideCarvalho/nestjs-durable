---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/durable-worker': patch
---

Cross-runtime control-flow recognition: workflow catch blocks that clean up on REAL failures had
no reliable way to let the engine's control-flow exceptions through — `instanceof
WorkflowSuspended` fails when the workflow executes on the thin worker, whose `ctx.step`/
`waitForSignal` suspends throw `@dudousxd/durable-worker`'s `Suspend` instead. A consumer that
misclassified a thin-worker suspend as a failure ran its cleanup DURING the suspend, emitted
extra checkpoints into history, and the resumed replay died with NondeterminismError.

All three control-flow signal classes (core's `WorkflowSuspended`/`ContinueAsNew`, worker's
`Suspend`) now carry the well-known marker `Symbol.for('aviary:durable:control-flow')`, and core
exports `isWorkflowControlFlowSignal(error)` — the ONE predicate workflow code should use in
catch paths: recognized signals must be rethrown untouched. `Cancelled` and `StepFailed` are
deliberately NOT control-flow (a terminal the consumer may handle, and a real failure); the thin
worker's `continueAsNew` throws `UnsupportedOnThinWorker`, a usage error, also excluded.
