---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

feat: executionTimeout — cap a run's wall-clock lifetime

`@Workflow({ executionTimeout: '2h' })` (or ms) moves a run to `cancelled` (`execution_timeout`) once
it outlives the budget — a backstop for runs that get stuck or loop forever. Enforced by a new
`engine.sweepTimeouts(now)` the timer poller calls each tick (over the existing workflow+status query;
no new schema). The terminal `cancelled` state means a late step result can't resurrect it.
