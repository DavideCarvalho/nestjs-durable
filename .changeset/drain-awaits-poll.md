---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
---

Shutdown now waits for the in-flight timer/retention poll. `TimerPoller` and `RetentionPoller` await their current sweep in `onModuleDestroy` (bounded by `shutdownTimeoutMs`, default 10s), so no store call is still pending when the host closes its pool. The engine gains `beginDrain()`, and `resumeLeased`, `recoverIncomplete`, `sweepTimeouts` and `schedules.tick` check `draining` before each lock or run, so a backlog stops being leased once shutdown begins.
