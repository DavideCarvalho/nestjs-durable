---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
---

Make singleton admission atomic and durable across engine instances. Persist admitted slots in
reserved run tags so later same-millisecond starts cannot displace existing holders. Preserve slots
through sleep, signals, blocked routing, cancellation, recovery and expired execution leases; clear
admission on terminal settlement. Park denied waiters within the admission transaction so concurrent
cancellation cannot revive a settled run. All bundled stores support the new atomic admission operation.

Custom stores must implement `StateStore.tryAdmitSingleton` to use singleton workflows; unsupported
starts fail before creating a run. Drain existing singleton runs and upgrade all workers together
before resuming starts, because older active rows have no admission marker. No schema migration is
required.
