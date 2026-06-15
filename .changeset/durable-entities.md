---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

Durable keyed **entities** (virtual objects) — a per-key actor whose handlers run **serialized over durable state**, exactly once. Generalizes singleton; ideal for counters, carts, rate-limiters, aggregators.

- **Core**: `engine.registerEntity(name, { initialState, handlers })`; `engine.signalEntity(name, key, op, arg)` (fire) / `engine.getEntityState(name, key)` (read); from a workflow, `ctx.callEntity(name, key, op, arg)` (call + await result) and `ctx.signalEntity(...)`. Each key is one long-lived run processing ops in order.
- **NestJS**: `@Entity({ name })` on an `@Injectable()` class with `@On(op)` methods over its fields (state); `EntityService.signal/getState`. A fresh instance per key is the initial state; methods are re-attached after replay.

(Per-key history compaction via continueAsNew for very-hot keys is a follow-up.)
