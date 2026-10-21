---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
---

Drain budget edge cases. `WorkflowEngine.beginDrain(spentMs)` now ignores non-finite or negative values instead of turning later drains into a ~1 ms wait. A `drain()` already waiting re-reads the reported wait, so a late `beginDrain(spentMs)` shortens it (deadline is its start plus the timeout minus the reported wait). The docs and the retention poller's comment now state that the retention sweep's shutdown wait is bounded by `shutdownTimeoutMs` on its own and is not deducted from the drain.
