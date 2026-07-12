---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
---

Fixes a lost-wake race in signal delivery: a signal (e.g. an agent HITL approve/reject) delivered
in the narrow window between a waiter's buffered-check and its waiter-row registration used to be
lost forever — the run stayed suspended, the buffered payload sat unpaired, and nothing ever paired
them (observed in production: the SSE stream never closed).

Three-piece fix:
1. **Waiter side** (`waitForSignal`'s both arms, and the remote `waitSignal` command): re-check the
   buffer once more immediately after registering the waiter, so a signal that raced in during the
   initial check is still caught before suspending. On a hit, the waiter removes its OWN row via the
   new exact-match `removeSignalWaiter` — never a blind `takeSignalWaiter(token)`, which deletes ANY
   row for that token and could otherwise steal a different run's waiter that has since claimed the
   same token (`token` is the store's primary key).
2. **Signal side** (`engine.signal`): after buffering a signal nobody was waiting for, re-check for a
   waiter that registered in that same window; if one appears, reclaim the buffer and deliver
   directly instead of leaving both rows stranded.
3. **Reconcile safety net**: the due-timer pass that already re-drives event-wait suspends (via their
   `reconcileMs` fallback `wakeAt`) now also pairs a stranded buffer + waiter for a suspended run in
   that batch — closing the residual window where a crash lands between the two ops on either side
   and neither side's own retry logic ever runs again.

New SPI: `StateStore.removeSignalWaiter(waiter)` deletes the exact `(token, runId, seq)` row (a
no-op if it no longer matches), implemented across every first-party store (in-memory, MikroORM,
Drizzle, Prisma, TypeORM) with a shared conformance case.

Regression-covered: normal (non-racing) signal/`waitForSignal` behavior, the `signalWithStart`
long-lived entity loop, and the timeout arm (which now cleans up only its own waiter row) are all
unchanged. Also fixes an unrelated TOCTOU this work surfaced: a `ctx.all` `failFast` cancel landing
on a sibling mid-turn could be clobbered back to `suspended` by that sibling's own (now-stale) settle
— `engine`'s suspend-settle re-checks for a concurrent cancel before writing.
