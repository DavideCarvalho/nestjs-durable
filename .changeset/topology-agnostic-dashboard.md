---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Topology-agnostic dashboard: `DashboardService` run views/control/stream now route through the `RUN_GATEWAY` port, so a store-less tenant can mount the same `DurableDashboardModule` the operator uses (backed by `ProxyRunGateway`). `RunGateway.cancel` gains an optional `compensate` opts; `DurableWorkerModule` is now `global` so a globally-mounted dashboard resolves `RUN_GATEWAY` on a tenant. Operator-only operations (metrics, worker health, webhook delivery, live event read, update delivery) require the control plane and throw a clear error on a tenant.
