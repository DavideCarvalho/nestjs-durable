---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-store-prisma': patch
---

Dispatched `ctx.step` gets fast: a step result no longer replays the workflow body over the run's whole history, and costs about half the SQL round trips.

- **Sticky continuations** (core): a body parked on dispatched `ctx.step` calls stays in memory between turns, and the run's next turn on the same instance continues it instead of replaying from the top, so per-step cost stays flat however long the run gets. It falls back to a normal replay whenever it can't be sure the parked body is current: the turn runs on another instance, another turn settled the run since, a cancel or retry, an eviction, a `ctx` call made while detached, a non-step suspension (sleep/signal/child/fan), or a registered execution wrapper. New engine / `DurableModule` options `stickyRuns` (default 1000 bodies, about 26 KB each; `0` turns it off) and `stickyIdleMs` (default 5 min). See the "Performance" section of the production guide.
- **Fewer round trips**: new optional `StateStore` methods `settleResultsIfPending` (settle results and read the rows back in one statement, folding in the finished-run check), `tryLockRunAndGet`, `insertCheckpointIfAbsent` and `claimPendingRuns` (batch claim with `FOR UPDATE SKIP LOCKED`). The Drizzle Postgres store, the in-memory store (opt-in via `new InMemoryStateStore({ roundTripMethods: true })`) and the codec wrapper implement them; stores that don't fall back to the existing calls. Single-statement settles and `updateRunIf` no longer open a transaction (Drizzle), and a single step result settles in one conditional UPDATE in the TypeORM, MikroORM and Prisma stores.
- **Run claiming**: without a run queue, `runPending` claims a batch of pending runs in one statement and runs it concurrently, so several polling replicas split the backlog instead of racing for the same rows.
- **Drizzle on node-postgres**: the per-step statements are sent as constant SQL text instead of being rebuilt by drizzle's query builder (which was ~40% of the engine's CPU). Values and rows go through drizzle's column encoders/decoders, a drizzle logger still sees every statement, and errors keep the `DrizzleQueryError` shape. New option `preparedStatements` (off by default) sends them as named prepared statements.
- **Fix**: a run cancelled between being read and its first turn is no longer resurrected to `running` (`markStarted` is a compare-and-set on `pending`).
- **Testing**: the state-store contract covers the new optional methods, including concurrent claimers.
