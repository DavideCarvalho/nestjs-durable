---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable-dashboard': patch
---

Retry ergonomics + wedged-step ceiling.

**core**
- `requeue` now CASCADES: retrying a parent that failed on an awaited child also requeues that failed/dead child, so the dashboard "Retry" on the parent converges by itself (parent-only used to be instantly re-failed by the reconciler re-delivering the child's still-failed terminal state). Skipped when a SUCCESS is already buffered on the child's token (see below) — the origin isn't re-run for nothing.
- `requeue` clears the stale `run.error`, so a re-executing run no longer shows its previous failure.
- A `retry-with-input` run's SUCCESS is now also delivered on its ORIGIN's `child:<origin>` token: a parent that failed on that child and is retried later adopts the fix's result instead of waiting on a child nobody re-runs.

**transport-bullmq**
- New opt-in `stepTimeoutMs`: a wall-clock ceiling per step handler. A wedged handler (an await that will never settle) used to hold its BullMQ job forever — lock renewal is timer-based, so the job was never reclaimed. At the deadline the transport publishes a RETRYABLE failed StepResult (durable retry re-dispatches) and abandons the orphaned promise.

**dashboard**
- A still-pending step no longer shows a `finished` timestamp next to its running duration.
