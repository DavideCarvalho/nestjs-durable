---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable': patch
'@dudousxd/nestjs-durable-dashboard': patch
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

**Recover a remote step whose dispatched job was LOST.** A remote step with no `timeoutMs` dispatches
its work, persists a `pending` checkpoint, and suspends until the result resumes it. If the worker
crashed mid-step (no result) or the transport dropped the job (a Redis flush/eviction, or a stalled
job moved to `failed` and removed), the result never came — and nothing re-dispatched it. Reconcile
re-drives re-suspend a still-`pending` step by design, `recoverIncomplete` only reclaims leased runs,
and the dashboard "retry" just replayed back to the same wait. So the run hung on `pending` forever.
Four independent closes:

- **`WorkflowEngine.redispatchPending(runId)` (core) + a "Re-dispatch" dashboard action** — the manual
  escape hatch: re-enqueues a run's stuck `pending` remote steps (bumping `attempts`) so the idempotent
  step re-runs and its result resumes the run. Exposed through `RunGateway` and over the tenant proxy.
- **Opt-in self-heal `remoteRedispatchMs` (core)** — when set, a reconcile re-drive that finds a remote
  step still `pending` past this window re-dispatches it (a clock-space deadline stamped on the
  checkpoint, stable across replays), bounded by `remoteRedispatchMax` (default 10) so a step that never
  settles fails as a `remote_step_lost` error instead of looping. Off by default: re-dispatch can
  double-run a merely-slow step, so the window must exceed the longest such step and steps must be
  idempotent. Prefer a per-step `timeoutMs` where you can; this is the store-driven net for the
  no-timeout steps that must survive a lost dispatch.
- **BullMQ transport bridges a terminal job failure (`transport-bullmq`)** — a crashed/stalled task job
  now publishes a synthetic failed `StepResult` (via `Worker.on('failed')`), so the engine marks the
  checkpoint `failed` and its normal durable retry re-dispatches — instead of the run hanging on
  `pending`. Requires retaining the failed job's payload briefly (`removeOnFail: { age }`) so the bridge
  can read the task identity before BullMQ GCs it. A handler business-error still succeeds the job (it
  already publishes its own failed result), so there is no double-publish.
- **Stale-pending visibility (dashboard)** — a remote step `pending` past `STALE_PENDING_MS` (10 min) is
  flagged in the timeline ("awaiting worker result — dispatched Nm ago (possibly lost)") instead of
  masquerading as a healthy in-flight step, so an operator can see and re-dispatch it.
