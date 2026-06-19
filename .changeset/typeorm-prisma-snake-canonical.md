---
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-store-prisma": minor
---

Pin the TypeORM and Prisma adapters to the canonical `snake_case` physical column names, so all four
store adapters (MikroORM, Drizzle, TypeORM, Prisma) agree on the schema and a run written by one is
readable by another. Each adapter now asserts its physical columns against the shared
`DURABLE_CANONICAL_COLUMNS` contract (`@dudousxd/nestjs-durable-testing`), so a future divergence is a
failing unit test instead of a runtime `Unknown column`.

**store-typeorm** — entities are now built by `durableEntities({ naming })` (a TypeORM `EntitySchema`
factory mirroring the MikroORM adapter): `'snake_case'` default, `'preserve'` for verbatim camelCase,
or a custom `(property) => string`. `ensureTypeOrmDurableSchema` and the search-attribute `EXISTS`
pushdown now resolve column names from the entity metadata (via a shared `durableColumnResolver`)
instead of hardcoding them, so the raw SQL can never drift from the entity mapping.

**store-prisma** — every multi-word field gains `@map("snake_case")` (Prisma is static codegen, so it
has no runtime naming choice — it is pinned to the canonical convention).

**BREAKING** for existing deployments whose `durable_*` tables were created by the *old* camelCase
schema of these adapters:

- **TypeORM**: register entities with `durableEntities({ naming: 'preserve' })` to keep reading the
  existing camelCase tables with no migration.
- **Prisma**: there is no runtime override — migrate the columns to `snake_case` (e.g.
  `ALTER TABLE ... RENAME COLUMN`) before upgrading, ideally alongside the deploy so older pods don't
  re-create camelCase columns.
