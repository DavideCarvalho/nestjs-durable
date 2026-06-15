---
"@dudousxd/nestjs-durable-core": minor
---

feat(scheduler): pause + overlap policy

`ScheduledWorkflow` gains two controls:
- **`paused`** — temporarily stop firing a schedule (kept registered).
- **`overlap: 'skip'`** (fixed-interval) — skip a window while the previous window's run is still
  `running`/`suspended`, so a slow run can't pile up overlapping executions (default `'allow'`).

Also adds a public `engine.getRun(runId)` pass-through.
