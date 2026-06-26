---
"@dudousxd/nestjs-durable-store-typeorm": patch
---

Add the `parallel_group` column to the `durable_step_checkpoints` DDL in `ensureTypeOrmDurableSchema`. The entity and store mapping already read/write `parallelGroup` (a `ctx.gather`/`ctx.all` fan tags sibling steps with the same group so the dashboard renders them as one parallel group), but the raw `CREATE TABLE` and the additive self-heal list never gained the column — so on a fresh boot the checkpoint table was created without `parallel_group`, and inserts failed with `no column named parallel_group`. The column is now created (nullable `varchar(191)`, matching `worker_group`) and back-filled on pre-existing tables, completing the `parallelGroup` migration.
