---
'@dudousxd/nestjs-durable-core': patch
---

Stop a run executing on two instances after a sleep wakes. A queued wake read the run while the same instance's timer hand-off held its short claim, the hand-off released it, and `execute` trusted the read and started a turn holding no lease, so another instance locked the run and ran beside it, and the first renewal, 15 s later on the default lease, reported the lease lost. `execute` now proves a re-entry with an owner-scoped renewal and never re-enters a claim in flight, and the hand-off's release is owner-scoped.
