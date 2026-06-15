---
"@dudousxd/nestjs-durable-core": minor
---

Crash recovery now **re-enqueues** orphaned runs instead of resuming them inline. Previously `recoverIncomplete()` (run on worker boot and every poll tick) resumed each crashed run synchronously — so a worker booting while a run had a long inline `ctx.step` (e.g. a big export rebuilt from scratch) would block on that step and never become ready (a deploy could time out). Now recovery counts the attempt (still dead-letters a poison pill past `maxRecoveryAttempts`), then sets the run `pending` and dispatches it — a worker re-runs it asynchronously, replaying its checkpoints. Boot and poll ticks return immediately. `recoverIncomplete()` now returns the runs as `{ status: 'pending' }`.
