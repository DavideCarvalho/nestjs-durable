---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Uniform durable start for tenant apps. `engine.start(...)` is now identical across topologies: a
tenant worker (no store) resolves the same `WorkflowEngine` token to a store-less `DurableStartClient`
that transparently publishes a start-run message to the control plane instead of touching a DB.
`searchAttributes` now ride the start-run path (`StartRunMessage` → `startRun` → the created run), so a
tenant start carries the same queryable data a local start does. Store/driver-bound ops on a tenant
worker (`cancel`/`deleteRun`/`resume`/`waitForRun`/`signal`/`signalWithStart`/`publishEvent`) throw a
clear tenant error (the operator owns them). No app-facing `start_run` call is introduced.
