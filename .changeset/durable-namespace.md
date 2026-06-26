---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable': minor
---

Add `namespace` run partitioning. An engine configured with a `namespace` stamps it on every run it
creates and only picks up / recovers / resumes-timers-for / times-out runs in that namespace. The
StateStore list methods (`listPendingRuns`, `listIncompleteRuns`, `listDueTimers`) and `RunQuery`
gain an optional namespace filter. Default `'default'` — byte-identical to a single-pool deployment.
Implemented for the MikroORM store; Drizzle/TypeORM/Prisma parity is a follow-up (they ignore the
filter until then). Read paths (dashboard, `getRun`) are intentionally not namespace-scoped.
