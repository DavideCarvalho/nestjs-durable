---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable': patch
---

Tenant-scoped control plane ⇄ operator-convention tenant workers: make the two tenant encodings
interoperate through a mixed transport pool.

A control plane scoped with `topology: { role: 'control-plane', tenant: X }` namespaces its
transport keyspace (`durable-X-*`, bare group tokens), while tenant workers — the Python SDK and the
TS `role: 'tenant'` worker — follow the OPERATOR convention: bare `durable-*` prefix with
`@X`-suffixed groups (`processing@X`). The two keyspaces couldn't see each other, so a scoped local
stack could never route a convention-resolved remote workflow to its own tenant worker: the group
was reported "not registered" (and, combined with the swallowed child-start failure, the parent hung
suspended forever).

- **core:** `TransportPool.transportWithLiveGroup(group)` — convention resolution
  (`resolveRemoteByConvention`) now dispatches on the transport whose keyspace actually reports the
  live group, instead of blindly on `pool.primary`. Single-transport pools behave exactly as before.
- **transport-bullmq:** a NAMESPACED transport now REFUSES to enqueue a `@tenant`-suffixed routing
  token (`dispatch`/`dispatchWorkflowTask`) with an error that names the fix — enqueueing it under
  the scoped prefix (`durable-X-tasks-<name>@X`) double-encodes the tenant axis onto a queue no
  worker anywhere subscribes. The loud throw lets a `TransportPool` fail over to a bare-prefix pool
  member. Un-namespaced (operator) transports and the `'default'` namespace are byte-identical to
  before.
- **nestjs:** `assertValidRole` accepts `transports` (plural) wherever `transport` was required.

The supported pairing: give the scoped control plane a pool of its (namespaced) primary plus a
bare-prefix secondary — `new BullMQTransport({ connection, namespace: 'default' })` (explicit, so
`useNamespace` never re-scopes it). Discovery, dispatch, results, decisions and heartbeats then
reach operator-convention tenant workers on the bare prefix. Only pair the bare secondary on a
PRIVATE broker: it consumes the shared bare control queues.
