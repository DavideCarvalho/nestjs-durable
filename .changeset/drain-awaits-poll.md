---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": patch
---

Shutdown now waits for the in-flight timer/retention poll. `TimerPoller` and `RetentionPoller` await their current sweep in `onModuleDestroy`, bounded by `shutdownTimeoutMs` (default 10s) and logging when the bound wins. On a driving operator the timer poller also calls `beginDrain`, so from module destroy the engine starts no new runs in process (they stay pending for the next poll or boot); a non-driving operator is unchanged and still runs work started during shutdown. The wait the poller actually spent is deducted from the registrar's `engine.drain()`, so poll wait plus drain stay within one `shutdownTimeoutMs`; time passing between the two (other hooks, HTTP close) is not charged. Core adds `WorkflowEngine.beginDrain(spentMs?)` and an optional `ScheduleHost.isDraining()`; `resumeLeased`, `recoverIncomplete`, `sweepTimeouts` and `schedules.tick` stop starting work once draining, and `resumeLeased` releases a lease taken as drain began. nestjs calls `beginDrain` optionally, so it still works against an older core.
