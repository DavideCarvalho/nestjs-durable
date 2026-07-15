---
'@dudousxd/nestjs-durable-dashboard': minor
---

The stale-pending step row now consults the group's live worker heartbeats instead of the wall
clock alone. "dispatched 33m ago (possibly lost)" was a pure time heuristic — a long-running step
(a 100MB ingestion read) looked identical to a genuinely lost dispatch. The row now joins the
step's `workerGroup` against `/workers` (`GroupHealth.liveWorkers`, shared react-query cache,
fetched only while a stale row is on screen):

- live heartbeat on the group ⇒ calm `⚙ being worked by <instance> — heartbeat Ns ago · K in
  flight` (no warning; long steps are expected to sit here);
- no live heartbeat ⇒ the original `⚠ … no live worker (possibly lost)` warning, which is when
  re-dispatch is actually warranted.

Applies to inline-expanded child timelines too (same row component). Honest limitation, documented
in the presentation helper: a fresh heartbeat proves the WORKER is alive, not that the step
progresses — work-level progress reporting needs a worker-SDK API and is future work.
