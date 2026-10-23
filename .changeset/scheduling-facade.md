---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

Scheduling helpers for NestJS apps, without reaching into `-core`.

- `scheduleRunIdAt(schedule, nowMs)` is now public. It returns the run id of a schedule's window at `nowMs`, so `engine.getRun(scheduleRunIdAt(dailyReport, Date.now()))` finds the run a schedule started, from the same `ScheduledWorkflow` object the module was given, without rebuilding the id from its key, cron expression and timezone.
- `@dudousxd/nestjs-durable` re-exports `runSchedules`, `scheduleRunIdAt`, `scheduledRunId`, `prevCronFireMs` and the `ScheduledWorkflow` / `RunSchedulesOptions` types.
