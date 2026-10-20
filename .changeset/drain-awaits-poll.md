---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": patch
---

Shutdown now waits for the in-flight timer/retention poll. `TimerPoller` and `RetentionPoller` await their current sweep in `onModuleDestroy`, bounded by `shutdownTimeoutMs` (default 10s) and logging when the bound wins. The timer poller's wait and the registrar's `engine.drain()` share that one budget, so shutdown does not take twice `shutdownTimeoutMs`. Core adds `WorkflowEngine.beginDrain(timeoutMs?)` and an optional `ScheduleHost.isDraining()`; `resumeLeased`, `recoverIncomplete`, `sweepTimeouts` and `schedules.tick` stop starting work once draining, and `resumeLeased` releases a lease taken as drain began. nestjs calls `beginDrain` optionally, so it still works against an older core.
