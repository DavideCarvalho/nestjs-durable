---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Make in-flight local steps visible. A local `ctx.step` now announces its body has started — emitting a `step.started` lifecycle event and (by default) persisting a `running` checkpoint — so a long-running step shows up in the dashboard the moment it begins, not only once it completes. Previously a local step was checkpointed only on completion, so an in-progress step was invisible.

- New checkpoint status `'running'` for a local step whose body is executing in-process. It's a placeholder overwritten by `completed`/`failed`, and never short-circuits replay (only `completed` does), so a crash mid-body simply re-runs the step.
- New engine option `trackStepStart` (default `true`). The `step.started` event always fires (the live SSE view sees the start regardless); the flag gates only the extra `running` checkpoint write. Set it to `false` on hot paths with many short local steps to halve their checkpoint writes — at the cost of reload-survivable in-flight visibility.
