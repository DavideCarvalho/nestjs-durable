# @dudousxd/nestjs-durable-testing

## 0.1.1

### Patch Changes

- `ctx.call` now **suspends the run durably** instead of awaiting the worker result in memory. The
  remote step writes a `pending` checkpoint, the run suspends, and the result resumes it on whichever
  engine instance receives it — so a worker/control-plane pod can scale down or crash mid-step without
  losing the run or re-running completed work. This makes `ctx.call` consistent with `ctx.task` /
  `ctx.sleep` (already durable). A step that sets `timeoutMs` keeps the in-memory await + heartbeat path
  (opt-in liveness, single-instance).

  **Breaking:** `engine.start()` / `WorkflowService.start()` now returns `suspended` (not `completed`)
  for a workflow that hits a remote `ctx.call` — the run finishes asynchronously when the result lands.
  Trigger-and-observe consumers are unaffected; anything that awaited `start()` to completion should
  poll the run status (or react to `run.completed`) instead.

  `StepCheckpoint.status` gains `'pending'` (an in-flight remote step), surfaced in the dashboard as a
  "running" node. In-process transports (event-emitter, the in-memory test transport) now deliver
  results on a later tick so the suspend settles first.
