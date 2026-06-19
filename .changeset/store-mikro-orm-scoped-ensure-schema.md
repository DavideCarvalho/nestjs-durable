---
"@dudousxd/nestjs-durable-store-mikro-orm": patch
---

`ensureMikroOrmDurableSchema` now manages only the store's own `durable_*` tables instead of running
a whole-ORM `orm.schema.update({ safe: true })`.

The recommended setup shares the host app's MikroORM instance (a single ORM avoids MikroORM's
global-metadata clobber between instances). But a whole-ORM `schema.update()` reconciles EVERY table
to the entity metadata — on a migration-managed app that means it tries to recreate the migrator's
table (`Table 'mikro_orm_migrations' already exists`) and drop the app's foreign keys, so the durable
auto-schema crashed app boot (and would churn/destroy schema if it didn't). It also meant a fresh DB
(e.g. an ephemeral CI database) never got the durable tables when the host disabled the broken
auto-schema.

Now it computes the safe additive diff (`getUpdateSchemaSQL({ safe: true })`) and executes only the
statements that target the `durable_*` tables. `getUpdateSchemaSQL` emits a `create table` only for a
missing table and `alter table ... add` only for a missing column, so this stays idempotent: missing
durable tables are created, existing ones are extended additively, and the rest of the host schema —
app tables and the migrations table — is never touched. Auto-schema (and calling this from a
migration) is now safe on a shared, migration-managed ORM.
