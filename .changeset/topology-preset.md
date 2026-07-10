---
'@dudousxd/nestjs-durable': minor
---

**`DurableModuleOptions.topology` — an explicit, validated deployment-role preset.** Today the
operator/worker split is only inferred from which of `store`/`connection` are set, and the boundary
between `namespace` (the operator's poll-scoping axis) and `partition` (the worker's queue-routing
suffix) is only documented in prose — a real consumer app grew a 250-line module whose comments exist
solely to reconcile the two. `topology` names the role up front and validates the axes for you:

```ts
// Control plane: owns the store, dispatches over the transport.
DurableModule.forRoot({
  topology: { role: 'control-plane' },
  store,
  transport,
});

// Tenant: store-less worker scoped to its own partition — `tenant` maps onto `partition` for you.
DurableModule.forRoot({
  topology: { role: 'tenant', tenant: 'acme-corp' },
  connection: process.env.REDIS_URL,
});
```

- `{ role: 'control-plane' }` requires `store` + (`transport` or `transports`); forbids `partition`
  (a worker axis) and a `tenant` field. `namespace` and `connection` stay allowed.
- `{ role: 'tenant', tenant }` requires `connection`; forbids `store` (a tenant is store-less by
  definition) and `namespace` (the operator's own axis); maps `tenant` onto `partition` internally —
  an explicit `partition` that disagrees with `tenant` throws, one that matches is a no-op.
- Every rejection is a multi-line error naming the role, the offending option, and the one-line reason
  — these messages are the point, not just the validation.
- `topology` is entirely additive: omit it and `store`/`connection` inference is unchanged.

See [Tenancy & topologies](https://davidecarvalho.github.io/aviary/docs/durable/concepts/tenancy#the-topology-preset).
