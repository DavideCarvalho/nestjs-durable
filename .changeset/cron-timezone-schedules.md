---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

feat: cron + timezone schedules

`ScheduledWorkflow` now accepts a `cron` expression with an IANA `timezone` (DST-aware) as an
alternative to the fixed-interval `everyMs`. The run id is keyed on the most recent fire time, so
polling repeatedly within an interval — or racing instances on the same tick — starts each fire
exactly once (idempotent). The NestJS module gains a `schedules` option; the timer poller fires them
each tick on **worker** instances only. Cron evaluation uses the optional `cron-parser` peer
dependency, so the core stays dependency-free for users who don't schedule by cron.
