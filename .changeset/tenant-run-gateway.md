---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/nestjs-durable": minor
---

Tenant run gateway: a store-less tenant worker can now read (getRunDetail/listRuns), control
(cancel/retry/continue/retryWithInput), and live-stream its OWN runs over the shared transport, via a
new `RunGateway` port. The control plane binds a store-backed gateway and answers tenant requests —
scoped to the tenant's namespace — over a new run-request queue plus run-reply and per-tenant-event
pub/sub channels; a tenant binds a `ProxyRunGateway` (given an app-supplied transport). No store and no
HTTP on the tenant side; every request is namespace-scoped so a tenant can never read or act on another
tenant's run. `EngineEvent` now carries an optional `namespace` (stamped on `run.*` lifecycle events)
so the control plane can re-publish a run's events to its owning tenant.
