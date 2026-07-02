---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/durable-worker': minor
---

Collapse the role-declaration surface and drop the Phase-1 deprecation aliases (breaking, 0.x).

- **One module, role inferred.** `DurableModule.forRoot(options)` is the only entry point. `{ store, transport }` → operator (engine + store + drivers, executes bodies inline). `{ connection }` (no store) → thin worker (store-less start client + `ProxyRunGateway` + one queue subscribed per registered `@Workflow`/`@Step`). `{ store, transport, connection }` → operator that dispatches its own bodies to a co-located per-name worker (uniform dispatch). `partition?` is the only isolation knob; `drive?` (default true for an operator) stays for read-only store replicas. **`DurableWorkerModule`, `DurableControlPlaneModule`, and the `inAppWorker` option are removed** — folded into `DurableModule`.
- **Convention dispatch is the default.** The `remoteByConvention` flag is removed: an operator with no local body for a workflow and a live worker of that name dispatches to it automatically (route-by-name makes it correct by construction); an unknown workflow still throws `not registered`.
- **Deprecation aliases removed.** `ctx.call` (use `ctx.remote`), `remoteStep({ group })` (use `partition`), `DurableWorkerModule` `groups`/`tenant`/`concurrencyByGroup`, `BullMQTransport({ group })` (use `partition`), Python `Worker(group=/tenant=)` (use `partition`). Python bumped to `0.21.0b0`.

Canonical config is now two shapes: operator `{ store, transport }`, worker `{ connection, partition? }` — everything served is derived from the `@Workflow`/`@Step` decorators. Breaking cut; the durable fleet (operator + JS/Python workers) adopts the new surface together, as it already must for any routing change.
