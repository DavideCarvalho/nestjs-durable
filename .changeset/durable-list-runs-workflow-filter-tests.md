---
"@dudousxd/nestjs-durable-core": patch
---

Add regression tests for the `listRuns({ workflow })` filter on the run-query API.

The store-level run-query path already supports filtering runs by their registered workflow name via `RunQuery.workflow` — it is implemented across every store adapter (in-memory, MikroORM, Prisma, TypeORM, Drizzle) and surfaced through the dashboard `GET /runs?workflow=` endpoint and `WorkflowEngine.listRuns`. This adds the previously-missing unit coverage proving the in-memory store returns only runs of the named workflow, that the filter composes with `status` (both predicates must hold), and that an unmatched name yields an empty list. No public API or behavior change.
