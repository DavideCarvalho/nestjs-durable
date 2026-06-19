---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-admission-redis': minor
'@dudousxd/nestjs-durable': minor
---

Pluggable admission backend + Redis-backed global flow control.

The remote-step flow-control gate (`ctx.call(step, input, { queue })`) is now driven by a pluggable
`AdmissionBackend` instead of an in-process-only controller:

- **core** — new `AdmissionBackend` interface; the default `InMemoryAdmissionBackend` preserves the
  existing per-instance behaviour. Inject a custom backend via `new WorkflowEngine({ admission })`.
  The admit/release path is async, and an optional `onFreed` capability lets a freed slot wake this
  instance's blocked runs early instead of waiting for their retry tick.
- **@dudousxd/nestjs-durable-admission-redis** (new) — `RedisAdmissionBackend` makes `concurrency`,
  `rateLimit`, priority **and** `fairness: 'key'` ordering GLOBAL across engine replicas, enforced by
  one atomic Lua script:
  - **Concurrency** via slot→instance ownership: a slot is reclaimed only when its owner's liveness
    heartbeat lapses, so a live pod holds it for the full step duration (no time-lease false purge)
    while a crashed pod's slots free within `instanceTtlMs`.
  - **Rate limit** via a fixed-window counter.
  - **Ordering** by priority desc → fairness round-robin by `key` → arrival FIFO, with abandoned
    waiters pruned so a cancelled run can't deadlock the rest as a phantom best-waiter.
  - **Early wake** by publishing a freed-slot signal on `release` that the engine subscribes to.
- **nestjs** — `DurableModule.forRoot({ admission })` forwards the backend to the engine.
