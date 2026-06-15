---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

feat: singleton — serialize runs by key (durable FIFO mutex)

`@Workflow({ singleton: { key: (input) => `base:${input.baseId}` } })` runs at most one run per key
at a time (e.g. one pipeline per base). Same-key runs queue — suspended, admitted in creation order
as slots free — instead of running concurrently. `limit` (default 1) raises the concurrency. Race-free
and FIFO on a consistent store: admission is the same `(createdAt, id)` view for every engine instance,
implemented over the existing tag+status query (no new schema). Also exposed as
`engine.register(name, version, fn, { singleton })`.
