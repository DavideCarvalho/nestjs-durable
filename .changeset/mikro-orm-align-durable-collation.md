---
"@dudousxd/nestjs-durable-store-mikro-orm": patch
---

Align durable-table collation to the ORM's configured `collate` (MySQL/MariaDB).

MikroORM's auto-schema (`getUpdateSchemaSQL`) creates tables with the server's DEFAULT collation — on MySQL 8.4 that's `utf8mb4_0900_ai_ci` — and ignores the `collate` config option. When the host app pins a different collation on its own tables (commonly `utf8mb4_unicode_ci` via migrations), a JOIN between a durable table and an app table throws `Illegal mix of collations`.

`ensureMikroOrmDurableSchema` now converges this after the additive pass: it reads the ORM's configured `collate` and `ALTER … CONVERT TO`s only the durable tables whose collation differs. Idempotent (matching tables are skipped), non-fatal (a failed CONVERT is warned, never crashes boot), and a no-op when no `collate` is configured or the platform isn't MySQL/MariaDB. This fixes both pre-existing tables and ones freshly created by auto-schema.
