---
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
"@dudousxd/durable-worker": minor
---

Data tenancy follows the full nestjs-context 2.1 contract, and still works with older contexts.

- Nested tenants: `tenancy: { kinds }` stamps and filters by that level of the request's tenant chain,
  so a clinic's runs are shared by its units. `family` reads a secondary tenant instead.
- `required` (or the context's `tenancy.required`): an app-facing start, read or control call in a
  request with no tenant fails with `TenantRequiredError` (403), returned as a rejection. Durable's own
  work never fails for it: turns, resumes, recovery, schedule fires and worker steps.
- A run's tenant is restored through the context's tenancy slot when it is published (context 2.1+),
  in the configured `family`.
- Console: runs with a tenant show an organization chip labelled by the context's `tenancy.label`
  resolver, else the slug, else the id.
- Tenant processes: `start` sends the customer tenant as an optional `tenantId` / `tenantKind` on the
  start-run message. The control plane keeps it only when the verified token's `capabilities` grant
  `tenancy:*` or `tenancy:<id>`. The process's own run gateway narrows its reads and control calls to
  the request's tenant.
