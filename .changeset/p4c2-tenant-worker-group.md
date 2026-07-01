---
'@dudousxd/durable-worker': minor
'@dudousxd/nestjs-durable-core': minor
---

`runRedisWorker` accepts a new `tenant` option, DISTINCT from `prefix` (the transport prefix is
untouched — typically shared with the operator control plane). Only the worker GROUP it
registers/heartbeats under is derived via `tenantGroup(group, tenant)`
(`@dudousxd/nestjs-durable-core`): `undefined`, `''`, or `'default'` stays byte-identical to the
bare `group` (production unchanged); any other tenant becomes `<group>@<tenant>`, so an
operator's `listWorkerGroups()`/`resolveRemoteByConvention` can route that tenant's runs to this
worker instance. `tenantGroup` is now also re-exported from `@dudousxd/nestjs-durable-core`'s
package root (it was previously only an internal module).
