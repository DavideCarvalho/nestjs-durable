---
'@dudousxd/nestjs-durable-telescope': patch
---

Tell apart the two blank cells in the Workers table.

`—` meant both "this worker's heartbeat carries no `WorkerStatus` at all" and "it reports fine, it
just has nothing to measure yet". Those are different incidents. The first is a fleet that has
stopped talking, or an SDK too old to; the second is the normal state of an idle deployment —
`throughputPerMin` and `p95Ms` come off the adaptive controller's rolling window of completions, so
they are absent until a step finishes inside it, and `lastAdjust` is absent until the controller
actually moves the limit.

Rendering both the same way sends a reader hunting for a broken worker that is merely idle. A
deployment where every `py-flip-*` row showed `—` for Thrpt/min, p95 and Last adjust was exactly
that: healthy workers, empty window.

Now `n/a` is "not reported" and `—` is "nothing to measure yet". Mode, limit, in-flight and the
min–max range are never measurements — a status either declares them or there is no status — so
their absence is always `n/a`.
