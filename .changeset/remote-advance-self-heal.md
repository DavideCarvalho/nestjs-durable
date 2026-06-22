---
"@dudousxd/nestjs-durable-core": minor
---

A timed-out remote workflow `advance` now **re-drives via recovery instead of marking the run `failed`** (opt-in, default-off). When a `RemoteWorkflowExecutor` is configured with `timeoutMs` and a workflow decision is dropped (a BullMQ stall/redelivery or an engine-instance restart spanning the in-memory `taskId` waiter map), the advance rejects with `RemoteWorkflowTimeout`; the engine releases the run's lease and leaves it recoverable rather than failing it, so `recoverIncomplete` re-drives a deterministic replay that settles the run and notifies its parent. A genuine executor error still fails the run, unchanged.

Default behavior is unchanged: with no `timeoutMs` set, the advance awaits as before. **Hazard:** a timeout firing while a worker is legitimately mid-step (not yet checkpointed) would re-drive and re-run that step → duplicate side effects, so a configured `timeoutMs` must be set generously (longer than the longest legitimate turn). A liveness/heartbeat-rearmed deadline (so only a genuinely-dead worker re-drives) is the documented follow-up.
