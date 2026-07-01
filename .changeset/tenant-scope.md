---
'@dudousxd/nestjs-durable-store-mikro-orm': minor
---

Add a `namespace` MikroORM global filter to `WorkflowRunEntity` and a `scope?: { namespace?: string }` constructor option to `MikroOrmStateStore`. When `scope.namespace` is set every forked `EntityManager` activates the filter, confining reads to that tenant's rows. When unset (the default) the filter returns `{}` — no restriction — so the control-plane / operator view and all existing behaviour are unchanged.

Add a `MikroOrmStateStore.withScope({ namespace })` method that derives a tenant-scoped view sharing the same ORM, so a pre-built (operator) store can be re-scoped at wiring time — this is the capability the NestJS module's `scopeReads` option consumes (it receives an already-instantiated store and can't reconstruct it).
