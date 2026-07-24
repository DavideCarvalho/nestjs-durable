---
'@dudousxd/nestjs-durable-core': patch
---

fix(core): orphan recovery no longer dead-letters a run whose remote step is still in flight

`recoverIncomplete` inferred "the run lease is acquirable" ⇒ "its worker crashed". That inference
does not hold for a run awaiting a **dispatched remote step**: the work sits on the transport and
nobody holds the RUN lease while a worker executes it. Every such pass incremented
`recoveryAttempts`, so a long-running step could exhaust `maxRecoveryAttempts` and the run was moved
to `dead` with a generic `max_recovery_attempts` error while its worker was still processing
normally (seen in production: 10 attempts in 57 seconds, the step's job still `active` on the queue).

`recoverIncomplete` now checks for an in-flight (`pending`) remote checkpoint before counting. When
one exists the run is not an orphan, so instead of counting an attempt and re-dispatching, the engine
re-asserts the state the contract already specifies for it (`StepCheckpoint.status`: `pending` = the
run is durably suspended) — it parks the run `suspended` on the reconcile timer and hands the lease
back. The worker's result resumes it as usual, `resumeDueTimers` remains the safety net, and the run
drops out of the orphan sweep entirely instead of accruing recovery attempts.

Genuine poison pills are unaffected: a run that crash-loops with no dispatched step in flight (or
whose remote steps have all settled) still counts attempts and still dead-letters. A LOST dispatch is
still not this pass's job — `remoteRedispatchMs` and `redispatchPending` own that, unchanged.
