---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-testing': minor
---

Data tenancy: scope runs by the customer they belong to (`@dudousxd/nestjs-context` ≥ 1.2's tenant). Off unless the context turns tenancy on; `DurableModule.forRoot({ tenancy })` takes `'inherit'` (default), `false`, or `{ enabled, kinds, nullRows }`.

- Runs and persisted schedules gain nullable `tenant_id` / `tenant_kind` columns (plus an index) in every store adapter. MikroORM, TypeORM and Drizzle Postgres (auto-schema) add them on boot; Prisma users copy the new fields from `prisma/schema.prisma` and migrate; **Drizzle SQLite/libSQL users must run the `ALTER TABLE` statements from the Drizzle store docs before upgrading**, because Drizzle selects every declared column.
- `StartOptions.tenantId` / `tenantKind`: an explicit value wins, else the request's tenant when tenancy is on, else none. Children, `continueAsNew`, retry-with-input and schedule fires inherit the tenant.
- The engine restores the run's tenant around every turn (timer, signal, recovery and worker-driven resumes), and a `DurableModule` restores a dispatched step task's tenant around its handler on any transport. The context carrier now also carries `tenant` (with its kind).
- App-facing reads and control calls (`getRun`, `signal`, `cancel`, `requeue`, `retryWithInput`, `engine.schedules`, …) and the dashboard's run gateway apply the matching rule: another tenant's run reads as not found. `RunQuery` and `ScheduleQuery` gain `tenantId` / `tenantIds`; `engine.scopeRunQuery(query)` narrows a query for your own listings.
- `waitForRun`, `getRunChildren`, `triggeredRuns` and the dashboard's live run event stream apply it too: `waitForRun` on another tenant's run rejects with `run <id> not found` (a run that does not exist yet is still waited for).
- Named events are per tenant: a tenant's `publishEvent` resumes only the waiters it may see, and its buffered copy is consumed only by those runs. A publish from `Context.allTenants` or outside a request stays global; with tenancy off nothing changes.
- `eventBatch` subscribers (debounce or batch) keep one batch run per tenant: a tenant's events go into that tenant's own batch run (id prefix `__evtacc__@<tenant>:`), stamped with it, and a run's lifecycle events into the batch run of the run's tenant. Publishes with no tenant, from `Context.allTenants` or outside a request keep the shared batch run with no tenant; with tenancy off batch run ids and rows are unchanged.
- The durable wire protocol is unchanged.
