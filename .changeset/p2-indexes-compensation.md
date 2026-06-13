---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-store-typeorm": patch
---

feat: saga compensation retry + visibility, and a dashboard query index

- **Compensation retry + visibility** — each saga undo is now retried up to `compensationRetries`
  (engine/module option, default 1) and emits a `compensate:<step>` step event for its outcome, so a
  stranded undo shows up in the dashboard/telescope instead of being silently swallowed. A
  permanently-failing compensation is still skipped so it can't mask the original failure.
- **TypeORM auto-schema index** — adds `(workflow, status)` alongside the existing `(status, wakeAt)`
  index, so the dashboard's `listRuns` filter hits an index.
