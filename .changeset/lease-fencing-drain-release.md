---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-testing": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
---

Lease takeover fencing, and `drain()` releases leases on timeout.

**Fencing.** The engine used to ignore the result of its lease renewals. A turn that stalled past `leaseMs` (a blocked event loop, a long GC pause, a store outage) kept running after another instance had taken the run over, and then wrote its outcome over the new owner's work. Now a renewal that reports the lease lost fences that execution: its completion, failure, suspension, continue-as-new, saga undo, blocked park or remote-turn decision is not written (the store's current state is reported instead), and it no longer releases the lease, which belongs to the new owner. It logs `[nestjs-durable] lost the lease of run … while executing it`. A renewal that throws is still not treated as a takeover, and a lease a turn gives away on purpose (a remote turn suspending on its dispatched decision) is not mistaken for one.

**Drain.** When `drain(timeoutMs)` (`shutdownTimeoutMs` in `DurableModule`) runs out of budget with runs still executing, it now releases their recovery leases, fencing those turns first, so another instance recovers them on its next pass instead of waiting up to `leaseMs`. It logs which runs it released.

**`StateStore.releaseRunLock(runId, owner?)`.** The new optional `owner` argument makes the release owner-scoped: only a lease `owner` still holds is cleared. The drain uses it so it never frees a lease another instance already took over. Every first-party store, the in-memory store and `CodecStateStore` implement it; a third-party store that ignores the argument keeps working (it releases unconditionally, as before). The state-store conformance suite in `@dudousxd/nestjs-durable-testing` gains a case for it.

Also adds `engine.listCheckpoints(runId)`, a pass-through to the store.
