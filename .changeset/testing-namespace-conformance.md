---
'@dudousxd/nestjs-durable-testing': minor
---

Assert the tenant boundary once, for every adapter.

`runStateStoreContract` gains a case covering all four paths
`WorkflowRun.namespace` promises a worker stays inside — picks up, recovers,
resumes timers for, times out — rather than the three whose signature names the
parameter. The fourth is `listRuns`, reached by `engine.sweepTimeouts`, and it is
the one with a write behind it.

It pins three things a narrower test would miss: that foreign runs do not eat the
FIFO budget (a store filtering after the limit answers an empty page and looks
like an idle tenant); that `undefined` is the operator view rather than
`IS NULL`; and that the unscoped calls still answer across namespaces, so scoping
cannot have been achieved by making the default restrictive.

`namespace` also joins `DURABLE_CANONICAL_COLUMNS`, now that every adapter
carries the column.
