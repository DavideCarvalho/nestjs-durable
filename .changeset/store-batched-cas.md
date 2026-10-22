---
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-testing': minor
---

Every bundled store implements `saveCheckpointsIfPending(checkpoints)`: `saveCheckpointIfPending` for a batch, resolving one boolean per entry, in one commit. If it rejects, it wrote nothing.

- Drizzle Postgres runs one `UPDATE … FROM (VALUES …) WHERE c.status = 'pending' RETURNING c.run_id, c.seq` per 500 rows. A row named twice in one batch goes into a later statement, so the second entry is compared against the first one's write.
- Drizzle SQLite/libSQL, TypeORM, Prisma and MikroORM run the same conditional `UPDATE` as `saveCheckpointIfPending`, once per entry and in order, inside one transaction.

The shared `runStateStoreContract` expects the method to exist and checks it: rows already settled are refused, a second copy of a row in one batch is compared against the first, missing rows are never created, rows of different runs can share a batch, a pending-to-pending write leaves the row open for a later entry, and a 600-row batch is written whole. A custom store without the method now fails those cases. The engine still works with such a store, settling each result with its own `saveCheckpointIfPending`.
