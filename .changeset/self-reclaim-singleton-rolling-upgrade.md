---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-testing": minor
---

Immediate self-reclaim after a crash, and singleton admission that is safe during a rolling upgrade.

**Self-reclaim.** Since 0.80, recovery only lists runs whose lease is free or expired. A pod with a stable `instanceId` that was killed without a graceful shutdown (OOM, SIGKILL) therefore waited up to `leaseMs` for its own leases after it restarted. Recovery now also reclaims, right away, the runs still leased by its own `instanceId` whose lease expires before this process's boot time plus `leaseMs`. Those leases were taken by the previous process. Any lease this process takes or renews expires later than that, and a run this process is executing (its in-process run gate is open) is skipped. A gate is held while such a run is recovered, so a resume landing meanwhile queues behind it. Other instances still wait for the lease to expire. `StateStore.listOrphanedRuns` takes an optional fourth argument, `ownedBy: { owner, lockedBefore }`, implemented by every bundled store, the in-memory store and `CodecStateStore`, and covered by the store contract. A custom store that ignores it keeps the 0.80 behaviour. This relies on a live `instanceId` being unique per process.

**Singleton rolling upgrade.** Replicas older than 0.73 admit singleton runs by a scan and write no `durable:singleton:admitted` tag, so a new replica could start a second run beside an old replica's holder. The holder count now also includes legacy holders: untagged `running`/`suspended`/`cancelling` runs of the key that lack the new reserved `durable:singleton:tracked` marker, or that sit inside the old scan's `limit` window. New replicas write that marker on a singleton run's first execution and on every denial (`singletonAdmissionDenialPatch` now returns `tags`). Admission and terminal settlement remove it, and it is stripped from user start tags (`SINGLETON_RESERVED_TAGS`). Legacy waiters keep their FIFO place, and the new admission takes over once a legacy holder settles. The singleton and production docs no longer tell you to drain singleton runs before upgrading.
