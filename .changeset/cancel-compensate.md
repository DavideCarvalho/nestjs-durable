---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/nestjs-durable-codegen": patch
---

feat: compensating cancellation — `engine.cancel(runId, { compensate: true })`

Cancelling a run can now undo its saga first: the suspended run is resumed with a cancellation
pending, so replay re-registers the saga and its completed steps' compensations run in reverse
(visible as `compensate:<step>` events) before the run is marked cancelled. Plain `cancel()` is
unchanged (immediate, no undo). The dashboard's cancel accepts `?compensate=true`
(`durableClient.cancel(id, { compensate: true })`), and the codegen client exposes the flag.
