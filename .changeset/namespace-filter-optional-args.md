---
'@dudousxd/nestjs-durable-store-mikro-orm': patch
---

Make the `WorkflowRunEntity` `namespace` global filter's argument optional (`args: false`) so an operator app that shares its ORM with the store can read `WorkflowRunEntity` directly through its own EntityManager without `MikroORM` throwing `No arguments provided for filter 'namespace'`. The filter is still `default: true` and the store's own forks still set the scope via `setFilterParams` (so tenant scoping is unchanged), but a consumer that never sets the param now gets the operator view (cond receives `undefined` → no-op → sees all rows) instead of an error. Previously such an app had to seed the param itself (e.g. `em.setFilterParams('namespace', { namespace: undefined })` at bootstrap); that workaround is no longer required.
