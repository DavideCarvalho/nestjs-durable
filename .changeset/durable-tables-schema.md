---
"@dudousxd/nestjs-durable-store-drizzle": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-transport-db": minor
---

New `schema` option: keep the durable tables in a database schema of their own (on MySQL, a database)
while your app stays in `public`. Every statement names it (`"durable"."durable_workflow_runs"`), so it
works behind PgBouncer in transaction mode; don't use `search_path` for this.

- Drizzle (Postgres): `new DrizzlePgStateStore(db, { schema })`, with your drizzle-kit tables from
  `durablePgTables(schema)`. `durablePgDdl(schema)` is the DDL for a hand-written migration. The SQLite
  `DrizzleStateStore` throws when `schema` is set.
- TypeORM and MikroORM: `durableEntities({ schema })` plus the store's `schema` option (Postgres and
  MySQL). A store whose `schema` doesn't match the entities fails with a message naming the fix.
- Prisma (Postgres): `new PrismaStateStore(prisma, { schema })` with `@@schema` on the durable models.
  It throws on MySQL (Prisma has no `@@schema` there) and SQLite.
- `DbTransport`: `new DbTransport({ ..., schema })`.

Auto-schema creates the schema when it is missing. Catalog lookups, the heal's advisory lock and
MikroORM's marker table all use the configured schema. Without `schema`, every statement is the same
as before. The name must be a plain identifier of at most 63 characters.
