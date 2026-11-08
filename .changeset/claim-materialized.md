---
'@dudousxd/nestjs-durable-store-drizzle': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-store-prisma': patch
'@dudousxd/nestjs-durable-store-mikro-orm': patch
---

Batched run claiming on Postgres picks its rows in a `MATERIALIZED` CTE. As a `FOR UPDATE SKIP LOCKED` subquery inside `UPDATE … FROM`, Postgres could rescan it, skip the rows the statement had just updated and take the next ones, so one claim of `limit` runs could lease every free pending run. The Drizzle hot path's buffered-signal take has the same fix. On MySQL, the MikroORM store's raw statements now run on the transaction's connection, so `FOR UPDATE SKIP LOCKED` holds its locks and two claimers never take the same run.
