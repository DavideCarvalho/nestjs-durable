---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-cli': minor
'@dudousxd/durable-worker': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
---

`ctx.waitForAny` and signal dedupe ids, the last two gaps with `@nestjs/workflows`.

- **`ctx.waitForAny(name, { a: ctx.signalWait(token), t: ctx.timer('3d' | { until }), c: ctx.childWait(runId) })`** resolves with the first condition's `{ key, value }`, typed per key and journaled at one position. Only the winning signal is consumed: a signal on a losing condition stays buffered for the next wait on its token (the wait is settled by a compare-and-set on its checkpoint; a signal that loses it is buffered again). A losing timer never fires; a losing child keeps running. Ties go to the signal sent first, then a finished child, then the earliest timer; a signal sent after a timer's deadline loses to it.
- **Remote protocol**: a `waitAny` `WorkflowCommand` (`{ seq, name, conditions: [{ key, kind: 'signal' | 'timer' | 'child', … }] }`) the engine resolves like the in-process ctx, replayed as an `any` `HistoryEvent` (`output: { key, value }`; a failed child is the event's `error`). The Node thin worker gains `waitForAny` / `signalWait` / `timer` / `childWait`; the Python SDK (`durable-worker`, released separately) gains `ctx.wait_for_any` / `signal_wait` / `timer` / `child_wait`.
- **`engine.signal(token, payload, { id, idTtl? })`** (and `WorkflowService.signal`): a re-send with the same token and id is dropped (resolves `null`) while the id is remembered, `signalIdTtl` (engine / `DurableModule` option, default 7 days). The timer poller deletes expired ids (`engine.sweepExpiredSignalIds()`). If storing the signal fails, the id is released so a retry gets through.
- **StateStore SPI** (all optional): `takeOldestBufferedSignal(tokens)`, `claimSignalId(token, id, expiresAt, now)`, `releaseSignalId(token, id)`, `deleteExpiredSignalIds(now, limit)`, implemented by the in-memory store, the codec wrapper and every bundled adapter, and covered by the state-store conformance suite.
- **New table `durable_signal_ids`** (`token`, `signal_id`, `expires_at`; primary key `(token, signal_id)`, index on `expires_at`). TypeORM, MikroORM and Drizzle Postgres create it at boot with auto-schema; Drizzle SQLite users get it from `drizzle-kit generate` (`signalIds` in `durableSchema`); Prisma users copy the `DurableSignalId` model and migrate. Only needed for signals sent with an `id`.
- **Codemod**: `durable migrate nestjs-workflows` now maps `ctx.waitForAny` (signalWait → token, timers kept, child handles → `ctx.childWait`), `WorkflowCondition` / `WorkflowAnyResult`, and `client.signal(…, { key, id })` → `signal(token, payload, { id })` instead of leaving TODOs.
