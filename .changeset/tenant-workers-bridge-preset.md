---
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable-core': patch
---

`topology: { role: 'control-plane', tenant, tenantWorkers: 'bridge' }` — one-line preset for the
tenant-worker bridge. Instead of hand-wiring a two-member `transports` pool (scoped primary +
bare-prefix secondary) behind an env-var conditional, a control plane declares that its tenant
workers follow the operator convention and the preset builds the pool itself:

```ts
DurableModule.forRoot({
  store,
  transport: new BullMQTransport({ connection }),
  topology: {
    role: 'control-plane',
    tenant: process.env.DURABLE_TENANT, // undefined on deployed pods — bridge is INERT then
    tenantWorkers: 'bridge',
  },
});
```

With `tenant` set, the configured `transport` (namespaced to the tenant by the engine) is paired
with `transport.withNamespace('default')` — a bare-prefix sibling — so operator-convention tenant
workers (`<group>@<tenant>` under the bare prefix: the Python SDK, the TS tenant role) are
discoverable and dispatchable. With `tenant` unset the option is inert, so one static config serves
both the scoped local stack and the global deployed operator. An explicit `transports` pool wins
over the sugar; a transport without `withNamespace` fails fast at config time.

- **transport-bullmq:** new `withNamespace(namespace)` — a sibling `BullMQTransport` on the same
  connection/prefix/partition, pinned to an explicit namespace.
- **core:** optional `Transport.withNamespace?(namespace)` interface hook.
- **nestjs:** the preset above; `TRANSPORT_CANONICAL` keeps feeding the step registrar with the
  singular `transport` (or falls back to the pool primary).
