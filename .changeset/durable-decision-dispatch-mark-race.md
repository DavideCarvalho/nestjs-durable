---
'@dudousxd/nestjs-durable-core': patch
---

fix(core): close the dispatch/mark race in the remote workflow-turn decision path

The multi-instance decision fix (0.44.0) recorded a remote turn's awaited `taskId` on the run
*after* calling `executor.dispatch`. In production the worker's reply round-trips the in-cluster
broker faster than the engine's marker write commits to a remote store — most visibly for a cached
re-drive replay that returns `completed` in under a millisecond — so the decision reached
`completeRemoteDecision` before `awaitingDecisionTaskId` was set, failed the marker guard, and was
dropped, leaving the run stuck `suspended` with the final decision already produced.

The dispatch-and-suspend path is now SUSPEND-then-ENQUEUE: the engine generates the turn `taskId`,
writes the awaited marker, and releases the run lease all BEFORE enqueuing the turn, so a decision —
however fast — always both matches the marker and can acquire the lease. `WorkflowExecutor.dispatch`
now takes the engine-supplied `taskId` and returns `void` (it only enqueues); `RemoteWorkflowExecutor`
no longer generates ids. Adds a regression test that delivers the decision synchronously on dispatch.
