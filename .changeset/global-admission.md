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
  The admit/release path is now async so a backend can do an atomic round-trip.
- **@dudousxd/nestjs-durable-admission-redis** (new) — `RedisAdmissionBackend` makes `concurrency`,
  `rateLimit`, and priority ordering GLOBAL across engine replicas (so `concurrency: 5` means 5
  in-flight across the whole fleet, not 5 per pod). Concurrency is a leased sorted set (a crashed
  holder's slot auto-expires), the rate limit a fixed-window counter, and blocked callers register in
  a priority-ordered waiter set — all enforced by one atomic Lua script.
- **nestjs** — `DurableModule.forRoot({ admission })` forwards the backend to the engine.
