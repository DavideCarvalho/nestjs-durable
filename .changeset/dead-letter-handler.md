---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

feat: dead-letter handler — `engine.onDead` + `deadLetterWorkflow`

Dead-lettering is no longer only "park the run in `dead`". `engine.onDead((run) => …)` fires when a
run is moved to `dead` (exceeded `maxRecoveryAttempts`), so a DLQ handler can alert, push to a real
queue, or compensate. The NestJS module adds a `deadLetterWorkflow` option that routes a dead run to
a designated workflow with `{ deadRunId, workflow, input, error }` (idempotent by a `dlq:<runId>` id).
Omitting both keeps the prior behaviour (the run stays parked, inspectable + retriable).
