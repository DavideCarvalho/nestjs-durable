---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable-store-prisma': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-testing': patch
'@dudousxd/nestjs-durable': patch
---

Follow-ups to the in-process run gate, settle compare-and-set and orphan-only recovery:

- A run parked `blocked` releases its lease best effort, like every other settle path. A failing release no longer replaces the `blocked` outcome with the lease error (or surfaces as an unhandled rejection for a background turn).
- Recovery on a store without `listOrphanedRuns` reclaims at most 500 orphans per pass (oldest first), the same bound as the store query, instead of every orphan at once.
- `updateRunIf` with a patch that maps to no column is a pure compare on the Prisma and TypeORM stores, like the Drizzle and MikroORM ones: Prisma reported `false` on a match and TypeORM threw. The shared store contract gains a case for it.
- `WorkflowService.waitForRun` accepts `until: 'terminal'` (it already forwarded it to the engine; the type now says so), which is what awaiting a delayed (`startAt`) run needs.
