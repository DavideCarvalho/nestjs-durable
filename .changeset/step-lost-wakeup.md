---
'@dudousxd/nestjs-durable-core': patch
---

A `ctx.step` result that lands while the turn that dispatched it still holds the run's lease now resumes the run. Before, that result's wake was dropped on the held lease, and the run stayed `suspended` with its step already `completed` until the reconcile sweep or the step's `remoteRedispatchMs` deadline. After releasing the lease, a turn that suspended on dispatched remote steps now re-checks them and re-drives the run if any has settled, the same way `ctx.all`/`ctx.child` fans already did. Under a 40k-child `ctx.all` on six workers this had parked about 5k children for an hour.
