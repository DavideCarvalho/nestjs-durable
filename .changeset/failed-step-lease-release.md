---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable-store-drizzle': patch
'@dudousxd/nestjs-durable-store-prisma': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-testing': patch
---

A failed `ctx.step` attempt on an engine with `remoteRedispatchMs` is now retried after its backoff, not after the lost-dispatch lease.

- **Settling a step clears its `wakeAt`.** With `remoteRedispatchMs` set, every dispatched step is written with its lease in `wakeAt` (and an inline replay stamps it on a step still in flight). A result settled the row without clearing it, and the retry policy reads a failed step's `wakeAt` as its backoff deadline, so the run waited for the lease (ten minutes per attempt with `remoteRedispatchMs: 600_000`) instead of `backoffMs`. `settleCheckpointsIfPending` and `settleResultsIfPending` now clear `wakeAt` in the same conditional write that claims the `pending` row, on every store adapter and every dialect path, and the engine's fallback for a store without them does the same. A settled step has no lease left; a step whose result never arrives is still `pending`, keeps its lease, and is still dispatched again once it passes. Policy `timeoutMs` and inline runs behave as before.
- **TypeORM and MikroORM write a cleared `wakeAt`.** `saveCheckpoint`, `saveCheckpoints` and the other checkpoint upserts left the stored `wakeAt` in place when the checkpoint had none, so a checkpoint saved without it kept its old value. This affected the engine's `remote_step_lost` and `remote_step_timeout` writes as well. They now write `NULL`.
- **Contract.** `runStateStoreContract` checks that a settle clears `wakeAt` (and that a row left `pending` keeps it), and that `saveCheckpoint` and `saveCheckpoints` clear a `wakeAt` the checkpoint no longer carries. A store that kept `wakeAt` across a settle now fails it. A third-party adapter whose settle keeps `wakeAt` therefore fails the contract suite after this upgrade: that is the bug this release fixes, and the adapter needs the same change.

Upgrade the store adapter with the core: a new core on an older adapter keeps the lease on a failed step, as before. A failed attempt settled before this release keeps its lease, so its retry still waits for it once.
