import type { MikroORM } from '@mikro-orm/core';

/**
 * The tables this store owns. Kept in sync with the `tableName`s in `./entities`. Used to scope
 * schema management to our own tables (see {@link ensureMikroOrmDurableSchema}).
 */
const DURABLE_TABLE_NAMES = new Set([
  'durable_workflow_runs',
  'durable_step_checkpoints',
  'durable_run_attributes',
  'durable_signal_waiters',
  'durable_buffered_signals',
]);

/** The table a `create table` / `alter table` statement targets, lower-cased; undefined otherwise. */
function targetTable(statement: string): string | undefined {
  const match = statement.match(
    /^(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?([\w$]+)[`"']?/i,
  );
  return match?.[1]?.toLowerCase();
}

/**
 * Idempotently create/extend ONLY the durable tables (additive — never drops). Safe to run on every
 * boot (auto-schema) and from a MikroORM migration when you disable auto-schema:
 *
 * ```ts
 * export class AddDurableTables extends Migration {
 *   async up() { await ensureMikroOrmDurableSchema(this.getEntityManager().getOrm()); }
 * }
 * ```
 *
 * It does NOT run a whole-ORM `schema.update()`. When the store shares the host app's ORM (the
 * recommended setup — a single ORM avoids MikroORM's global-metadata clobber between instances),
 * a full `schema.update()` would try to reconcile EVERY app table to the entity metadata: on a
 * migration-managed schema that means recreating the migrations table and dropping app foreign keys.
 * Instead we compute the safe additive diff and execute only the statements that target our own
 * `durable_*` tables. `getUpdateSchemaSQL` already emits a `create table` only for a missing table
 * and `alter table ... add` only for missing columns, so existing tables — and the entire rest of
 * the host schema — are left untouched.
 */
export async function ensureMikroOrmDurableSchema(orm: MikroORM): Promise<void> {
  const sql = await orm.schema.getUpdateSchemaSQL({ safe: true });
  const ours = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => {
      const table = targetTable(statement);
      return table !== undefined && DURABLE_TABLE_NAMES.has(table);
    });
  if (ours.length === 0) {
    return;
  }
  const connection = orm.em.getConnection();
  for (const statement of ours) {
    await connection.execute(statement);
  }
}
