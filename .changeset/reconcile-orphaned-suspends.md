---
'@dudousxd/nestjs-durable-core': patch
---

Self-heal runs that suspend waiting on an EVENT (a child's completion, a signal, a remote step with no `timeoutMs`) instead of a `ctx.sleep`. Those suspends carried no `wakeAt`, so if the wake was ever LOST — the delivering pod crashed or rolled mid-handoff — the run sat `suspended` with `wakeAt: null` forever: invisible to the timer poller (no `wakeAt`) AND to crash-recovery (no lease). In a singleton workflow this deadlocked the whole per-key queue behind the orphaned leader.

The engine now stamps a fallback `wakeAt` (new `reconcileMs` option, default 5 min; set `0` to disable) on any timer-less suspend, so `resumeDueTimers` re-drives it after the window. The re-drive is an idempotent replay guarded by existing checkpoints — a still-pending dependency simply re-suspends, a settled one advances — so it's a safe reconciliation, never a retry that can double-dispatch a step or count against `maxRecoveryAttempts`. A healthy run is still re-driven by its real event long before the fallback fires, so this only ever triggers for a genuinely-orphaned run.
