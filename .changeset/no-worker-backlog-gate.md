---
'@dudousxd/nestjs-durable-dashboard': patch
---

**`no-worker` is now gated on a real queue backlog, not bare `liveWorkers === 0`.**

A worker only heartbeats for a group while it's actively serving it, so an IDLE group — a suspended
run parked on its reconcile timer with nothing enqueued, or a scheduled workflow between its cron runs
— legitimately reports zero live workers even though nothing is blocked. The old check mislabelled
those runs `no-worker` even when every step was complete and the run was simply waiting to be
replayed/finalized.

`deriveRunState` now flags `no-worker` only when a group is STALLED — `depth > 0 && liveWorkers === 0`,
a backlog with no consumer (the alert condition `GroupHealth` itself documents). A parked/settled run
with no backlog reads `running` (open, in flight) and flips to `no-worker` only once its resume
actually enqueues with no consumer. This also corrects the header banner, which was counting
completed-work orphans as stalled.
