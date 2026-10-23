---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

`schedules` takes the workflow class: `{ key: 'daily-report', workflow: DailyReportWorkflow, cron: '0 2 * * *' }`, the same reference `ctx.child` and `engine.start` take. A registered name still works, for a workflow in another runtime.

- `ScheduledWorkflow<typeof DailyReportWorkflow>` checks `input` against the class's `run`. The plain `ScheduledWorkflow` accepts any input, as before.
- A schedule whose class isn't decorated with `@Workflow` makes the app fail to boot, instead of failing on every tick.
