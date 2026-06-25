---
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
"@dudousxd/nestjs-durable-store-prisma": patch
---

Persist `parallelGroup` on step checkpoints (parity with the mikro-orm adapter). A `ctx.gather`/`ctx.all` fan tags every sibling step with the same group so the dashboard renders them as one "ran in parallel" group, and the core engine carries it (including from a remote/polyglot worker's `recordStep`) — but these adapters had no column for it, so it was dropped on insert and read back as `undefined`, leaving the fan rendered as N sequential rows. Adds a nullable `parallel_group` column to the checkpoint table and maps it in both directions.

- **typeorm**: auto-added on boot by `ensureTypeOrmDurableSchema` (no manual migration).
- **drizzle / prisma**: the column is added to the schema/model; consumers manage their own schema, so apply a migration adding the nullable `parallel_group` column (e.g. `prisma migrate` / a drizzle migration). The reference `schema.prisma` now includes it.
