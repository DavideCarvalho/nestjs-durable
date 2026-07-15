---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable': minor
---

**One tenant encoding on the wire** — the engine's namespace no longer re-scopes the transport
keyspace. Per-run tenant routing now has exactly ONE encoding, the cross-SDK canonical convention
every worker runtime already speaks natively (the Python SDK, the TS tenant role): `@<tenant>`
GROUP suffixes (`processing@dev-alice`) on the transport's own prefix.

Previously a tenant-scoped control plane (`topology: { role: 'control-plane', tenant }`) auto-folded
its namespace into the transport prefix (`durable-<tenant>-*`), encoding the tenant TWICE (prefix on
the TS side, group suffix on the worker side) — two keyspaces that could never see each other, which
is why the `tenantWorkers: 'bridge'` pairing existed. With the propagation removed, a scoped control
plane lives on the same (bare) prefix as its tenant workers and reaches them natively: no bridge, no
second transport, no config beyond `tenant`.

The two axes are now fully orthogonal:

- **`topology.tenant` / engine `namespace`** — STORE axis: which runs this operator drives/recovers,
  and the tenant stamped on runs it starts (routed as `@<tenant>` groups).
- **Transport `prefix` / `namespace` (constructor options)** — whole-DEPLOYMENT isolation on a
  shared broker. Explicit only, never inferred from the engine.

Breaking (0.x): removed `Transport.useNamespace` / `TransportPool.useNamespace` (nothing calls them
— transports take their namespace at construction only), removed `Transport.withNamespace` and
`BullMQTransport.withNamespace`, and removed the `tenantWorkers: 'bridge'` topology option (all
introduced for the now-deleted double encoding; drop `tenantWorkers` from your config — `tenant`
alone now does the whole job). A NAMESPACED BullMQ transport still refuses `@tenant` routing tokens
loudly (that combination remains a double encoding — now it is always an explicit misconfiguration).

Deployed operators (namespace unset) were never affected by the propagation: their wire names are
byte-identical before and after.
