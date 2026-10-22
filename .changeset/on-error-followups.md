---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable-dashboard": patch
---

onError and allSettled follow-ups:
- Retrying a run whose failure was handed off runs its body again; the previous handoff is retired (renamed `onError:retried:<id>`), and a new failure goes to a new handler run. Handler runs are now `<runId>.onError.<attempt>`, and handoff checkpoints sit at seq 1,000,000,000 and up, past anything a body reaches.
- `FatalError(message, code?, details?)`: `details` (JSON-serializable) travels on the `StepError` to the run's error, an onError handler's input, and, with `code`, through a child's completion to the parent: `allSettled` rejected items carry `code`/`details`, and a failed `ctx.child` throws a `FatalError` with them. The Python SDK takes `FatalError(..., details=...)` and adds `ctx.all_settled`.
- A handed-off run is tagged `onError:<code>`, and the engine emits `run.routed`, or `run.unrouted` when the workers announce different routes. Announced routes are read once per 5s.
- `engine.unservedOnErrorRoutes()`, and a boot warning from the Nest module, for routes whose handler nothing can run.
