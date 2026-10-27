---
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-testing': patch
---

A run's row is written one statement at a time. On MikroORM, `updateRun` is one `UPDATE` of the patched
columns instead of a read of the row and a flush in a transaction, and `createRun` one `INSERT` instead
of a flush in a transaction. On TypeORM, `createRun` is one `INSERT` instead of `save` (a read, then the
insert in a transaction, overwriting a run that already had the id). A run of one step costs MikroORM
38 statements instead of 43, and a burst of 2,000 such runs on two pods sharing a 10-connection pool
each ran 6–8% faster. The shared store conformance suite checks both for every store that logs its
statements. `updateRun` of a run that does not exist still throws on MikroORM.
