---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

Lower idle cost of the timer poller. The listing of settled runs that still owe a lifecycle event (a tag filter over the runs table) and the heal of runs that missed a new subscriber now run once per `owedLifecycleSweepMs` (default 10 s) instead of on every 1 s poll; run waits are still swept every poll, and a listing that fails is retried on the next poll (`sweepLifecycleEvents(now, limit, { owed: false })` does the cheap part only). While polls find nothing to do, the wait between them backs off to `maxIdleIntervalMs` (default 5 s), never past the next due timer, blocked-run poll, persisted schedule or in-process schedule window (new `engine.nextDueAt`, `engine.schedules.nextFireAt` and `nextScheduleFireAt`), and any run event or enqueue nudge brings it back to `timerPollMs`. Only recovery (a crashed instance's runs, execution timeouts, housekeeping sweeps) waits up to that long. An engine with neither a control plane nor a run queue (`engine.idleBackoffSupported`) keeps the fixed tick, as does `maxIdleIntervalMs` at or below `timerPollMs`.
