---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Live step progress + per-sub-process log grouping, and a dashboard layout fix.

- **`step.progress` events**: a running step's log lines / sub-process outcomes are now emitted as
  `step.progress` engine events as they happen (not only batched onto `step.completed`). They ride
  the control plane like any lifecycle event, so the dashboard tails a long step line-by-line. The
  dashboard merges each one into the cached run instead of refetching (no store round-trip per line —
  and the store only has the events at completion anyway). `EngineEvent` gains an optional `event`.
- **`StepEvent.process`**: a log line emitted inside a sub-process can carry that sub-process's name,
  so the step detail panel groups a fan-out step's trail per sub-process instead of one flat list.
- **Dashboard layout**: the run-detail spans panel no longer collapses the WorkflowGraph to 0px. Its
  height now lives in the grid track (`1fr clamp(...)`); as an `auto` row it sized to the (tall) span
  content's min-content and stole the whole grid.

The Python worker client (`durable-worker`) gains the matching `StepContext.process(name)`, an
`on_event` sink on `process_task`/`aprocess_task`, and live `step.progress` publishing from the Redis
runner — released separately on its own version.
