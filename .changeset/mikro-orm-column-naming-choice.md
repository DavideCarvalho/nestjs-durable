---
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-testing": minor
---

Make the MikroORM store's physical column naming an explicit, configurable choice instead of an
implicit dependency on the host ORM's naming strategy.

The durable entities previously declared no column names, so the physical columns were whatever the
host MikroORM's naming strategy produced (its default `UnderscoreNamingStrategy` → `snake_case`). The
TypeORM and Prisma adapters, by contrast, defaulted to the verbatim camelCase property name. Nothing
pinned the two together, so the adapters silently disagreed on column names — and swapping a deployed
app from the TypeORM store to the MikroORM store failed at runtime with `Unknown column 'created_at'`
against the existing (camelCase) table. The divergence was invisible because each adapter's
conformance suite creates and reads back its *own* schema.

`@dudousxd/nestjs-durable-store-mikro-orm` now exposes `durableEntities({ naming })`, which pins
explicit column names onto the entity schemas per the chosen convention:

- `'snake_case'` (default) — the canonical convention, matching the Drizzle adapter.
- `'preserve'` — the verbatim camelCase property name, for an app whose tables were created by the
  old TypeORM/Prisma adapter and that wants to swap to the MikroORM store with **no migration**.
- a `(property) => string` function for any custom mapping.

`ENTITIES` is unchanged in spirit — it is now `durableEntities()` (canonical `snake_case`). The store
keeps resolving column names from ORM metadata, so it adapts to whichever naming the entities were
registered with.

`@dudousxd/nestjs-durable-testing` adds `DURABLE_CANONICAL_COLUMNS` (the canonical snake_case column
contract) and `assertDurableColumns()` — the cross-adapter guard the project lacked. Each adapter can
now assert its physical columns against one source of truth, so a future divergence is a failing unit
test instead of a production "Unknown column".
