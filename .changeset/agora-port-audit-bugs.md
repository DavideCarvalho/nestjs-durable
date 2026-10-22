---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-dashboard": patch
"@dudousxd/nestjs-durable-transport-bullmq": patch
"@dudousxd/nestjs-durable-transport-event-emitter": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
---

Correctness fixes ported from the AdonisJS sibling's audit.

- `ctx.callEntity` and `ctx.signalEntity` are exactly once across replay. A replay of a `callEntity` still waiting for its reply used to send the operation again (two replays applied it three times), and a turn that died after a `signalEntity` dispatch applied it twice. The operation is now stored durably in the entity's buffer, tagged with the caller's `<runId>:<seq>`, before the caller checkpoints, and the entity's run is created with it. `callEntity` records a pending intent first and marks it as sent with a conditional write that never overwrites a reply that already landed. The entity skips a copy re-sent with the same id. The wake-up is a no-op message, so ops stay in arrival order, and a lost wake-up is recovered by the `reconcileMs` sweep.
- `ctx.webhook().wait()` consumes a callback that arrived before the wait. `engine.signal` buffered it, but the wait never read the buffer, so the run waited forever. The wait now checks the buffer, registers, then checks again, like `ctx.waitForSignal`.
- The dashboard's `POST webhooks/:token` buffers an early callback when the token's run exists and isn't terminal, and answers with the run's status. It answers `404` for a non-webhook token, an unknown or terminal run, or a wait that already resolved, and buffers nothing for those. Before, every unmatched POST left a buffered row behind and still answered `404`. A duplicate that races a callback resolving the same wait takes its buffered row back and answers `404`.
- A child moved to `dead` by recovery (`maxRecoveryAttempts`) now notifies its parent right away as a failed child (`ctx.child` throws, `ctx.all`/`allSettled` record it). Before, the parent waited for its reconcile wake.
- An empty-string namespace is the `default` pool. An engine configured with `namespace: ''` stamps and polls `'default'`, a run started with `{ namespace: '' }` is stamped `'default'`, and a run stamped `''` is no longer refused by a `'default'` engine's resume and decision guards. An unset namespace is still the operator. Every store writes `''` as `'default'`. The Drizzle stores (SQLite and Postgres) also read legacy `''` rows back as `'default'` and match them with every `'default'` filter. On the MikroORM, Prisma and TypeORM stores, rewrite legacy rows once with `UPDATE durable_workflow_runs SET namespace = 'default' WHERE namespace = ''`. Such rows exist only if an engine ran with `namespace: ''` before this release.
- bullmq: a negative, NaN, infinite or above-2^31-1 `pingIntervalMs` falls back to the default instead of PINGing about every millisecond. A rejecting heartbeat handler is logged instead of becoming an unhandled rejection. When one `onDecision` handler fails, every handler runs to completion and each failure is reported before the decision is redelivered; before, the redelivery ran the others again while they were still running.
- event-emitter transport: a rejection while processing a task goes to `onError` instead of becoming an unhandled rejection.
