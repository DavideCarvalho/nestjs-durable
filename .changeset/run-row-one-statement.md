---
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-store-prisma': patch
'@dudousxd/nestjs-durable-store-drizzle': patch
'@dudousxd/nestjs-durable-testing': patch
---

A run's row is written without reading it first, and in one statement where the client allows it. On MikroORM, `updateRun` is one `UPDATE` of the patched
columns instead of a read of the row and a flush in a transaction, and `createRun` one `INSERT` instead
of a flush in a transaction. On TypeORM, `createRun` is one `INSERT` instead of `save` (a read, then the
insert in a transaction, overwriting a run that already had the id), and the insert no longer reads the row back on MySQL. On Prisma, `createRun` and `updateRun` use `createMany` / `updateMany`, which skip the read-back that `create` / `update` make (Prisma still wraps each in a transaction of its own). On Drizzle Postgres, a run without search attributes is inserted, and a patch without them applied, without a transaction. A run of one step costs MikroORM
38 statements instead of 43, and a burst of 2,000 such runs on two pods sharing a 10-connection pool
each ran 6–8% faster. The shared store conformance suite checks both for every store that logs its
statements. `updateRun` of a run that does not exist still throws on MikroORM and Prisma.
