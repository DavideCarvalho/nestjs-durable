---
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable-store-typeorm": minor
"@dudousxd/nestjs-durable-store-drizzle": minor
---

The boot-time schema check now logs one warning when it actually repairs a durable schema.

`ensureSchema()` (auto-schema) on the MikroORM, TypeORM and Drizzle Postgres stores fixes a schema that is behind the library: a missing table, column or index, a MySQL JSON column still `text`, or a MySQL collation that drifted. It used to do this silently. Now, when it changes something, it logs one line listing each change, for example:

```
[nestjs-durable] store-typeorm repaired the durable schema at boot: added column durable_workflow_runs.origin; created index durable_runs_namespace_status_idx on durable_workflow_runs. The database had drifted from the schema this library version expects …
```

An already-current schema logs nothing. A fresh install (no durable table existed yet) logs nothing too, because creating every table on the first boot is expected, not drift.

The warning goes to `console.warn` by default. Pass `schemaLogger` (anything with `warn(message)`, such as Nest's `Logger`) to the store constructor, or `{ logger }` as the new optional second argument of `ensureMikroOrmDurableSchema` / `ensureTypeOrmDurableSchema` / `ensureDrizzlePgDurableSchema`. Existing calls compile and behave as before, apart from the warning.

TypeORM on MySQL: the `text` to `longtext` widen now runs only for columns that are not `longtext` yet, instead of an `ALTER … MODIFY` on every boot.

The Drizzle SQLite store and the Prisma store have no auto-schema, so they don't log this.
