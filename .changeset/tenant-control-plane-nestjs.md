---
'@dudousxd/nestjs-durable': minor
---

Thread the tenant / control-plane options through the NestJS module:

- `remoteByConvention?: boolean` — forwarded to the engine so an unregistered workflow routes to the
  live worker group of the same name (default `false`).
- `scopeReads?: boolean` — opt-in tenant read scoping. When `true` and `namespace` is set, the module
  asks the store for a namespace-scoped view via an optional `withScope` capability (the MikroORM
  adapter provides it); a store without it is used as-is. Default `false` — the control plane stays
  unscoped (operator view).
- `DurableControlPlaneModule` — an intention-revealing alias whose `forRoot`/`forRootAsync` delegate
  to `DurableModule` with `worker: false` forced, for a dispatch/dashboard-only control-plane instance
  fronting tenant workers packaged via `DurableWorkerModule`.
