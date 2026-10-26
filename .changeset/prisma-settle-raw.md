---
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-testing": patch
---

The Prisma store settles a batch of step results with one raw statement per 500 rows on Postgres
and SQLite (`UPDATE … FROM (VALUES …) RETURNING`), and with a locking read plus one `UPDATE … JOIN`
on MySQL, instead of one `updateMany` per result. A 256-result batch on Postgres takes 10 ms whether
the steps' inputs are 10 B or 100 KB. A client without raw queries, or on another provider, keeps the
per-result `updateMany`. The store contract checks that `settleCheckpointsIfPending` sends a fixed
number of statements for a wide batch.
