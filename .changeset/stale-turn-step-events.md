---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/durable-worker': patch
---

A dispatched turn that went quiet and was dispatched again can no longer write its step checkpoints over the live turn's. `WorkflowStepEvent` carries an optional `taskId`, the dispatched turn whose replay ran the step, and the TypeScript worker sets it on every event it streams. The engine keeps a step event only while the run still awaits that turn (a turn counted lost or graced but not dispatched again yet still counts, as for its decision), and drops the events of a turn it no longer awaits, of a run that awaits no turn, or of a run that is gone. Before, the first copy of a re-dispatched turn kept streaming on its original worker and its events were written with no check, so a stale step output could replace the live one at the same seq. An event without a `taskId` (an older worker, or the Python SDK) is written as before. A worker on this release with an older core is unaffected: the core ignores the field.
