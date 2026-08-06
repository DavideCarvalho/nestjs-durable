---
'@dudousxd/nestjs-durable-store-typeorm': patch
---

Assert this adapter's column names against the cross-adapter contract

The MikroORM, Prisma and Drizzle adapters each have a `column-naming.spec.ts` that checks their
physical columns against `DURABLE_CANONICAL_COLUMNS`. This one did not — so its `col()` naming was
the only mapping the contract never verified, and TypeORM is one of the two adapters the contract was
written because of: it kept verbatim camelCase while MikroORM followed its ORM's naming strategy, and
a store swap failed against an existing table with "Unknown column" at runtime.

The new spec resolves the columns off an initialized `DataSource`'s entity metadata
(`column.databaseName`), not off the `EntitySchema` options this package writes. That distinction is
the point: TypeORM's naming strategy gets a say in `columnName(propertyName, customName)`, so reading
the options back would only confirm that `entities.ts` says what `entities.ts` says. It covers the
default, `'snake_case'`, `'preserve'` and a custom mapping function.

The naming was already correct — every property matched the canonical `snake_case` contract on the
first run, so no column changed. This only means the next one that drifts fails a unit test rather
than a production query.
