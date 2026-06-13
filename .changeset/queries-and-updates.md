---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/nestjs-durable-codegen": minor
---

feat: synchronous queries & validated updates

Two Temporal-style primitives adapted to the suspend/checkpoint model:

- **Query** — `ctx.setEvent(key, value)` publishes a named, replay-safe value; `engine.getEvent(runId, key)`
  reads the latest value of a live (or finished) run with no side effect. Exposed as
  `GET runs/:id/events/:key`.
- **Update** — `ctx.onUpdate(name)` is a run-scoped update point; `engine.update(runId, name, arg)`
  delivers to it, gated by a validator registered with `engine.registerUpdateValidator(workflow, name, fn)`
  that can **reject before the run is touched** (`{ accepted: false, reason }`). Exposed as
  `POST runs/:id/updates/:name`. The codegen extension emits both routes into the typed client.
