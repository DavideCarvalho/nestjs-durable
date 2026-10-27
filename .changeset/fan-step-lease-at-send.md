---
"@dudousxd/nestjs-durable-core": patch
---

With `remoteRedispatchMs` set, a step fan's steps are written with their lease already stamped, and
the run parks on it. Each step's lease was otherwise stamped on the fan's next turn, one write per
step, and the run had no wake until then. A beat from a step's worker, on the instance that sent the
fan, no longer reads the step to find its lease.
