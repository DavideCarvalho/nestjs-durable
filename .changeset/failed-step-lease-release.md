---
'@dudousxd/nestjs-durable-core': patch
---

A failed `ctx.step` attempt on an engine with `remoteRedispatchMs` is now retried after its backoff, not after the lost-dispatch lease. With that option set, every dispatched step is written with its lease in `wakeAt`, and a failed result settled the row without clearing it. The retry policy reads a failed step's `wakeAt` as its backoff deadline, so the run waited for the lease (with `remoteRedispatchMs: 600_000`, ten minutes per attempt) instead of `backoffMs`. Settling a failed remote step now clears that lease before the run resumes, while the row is still the attempt that failed. Completed steps, a step whose result never arrives (still dispatched again once its lease has passed), a policy `timeoutMs` (`remote_step_timeout`), and inline runs behave as before. A failed attempt settled before this release keeps its lease, so its retry still waits for it once.
