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
 * Whether a statement adds structure the store REQUIRES — a failure here is fatal (the store can't
 * run without the table/column/index). A column TYPE alignment (`modify`/`alter column ... type`)
 * is best-effort: the column already holds the data (the store serializes JSON to/from it regardless
 * of the declared type), so failing to converge its type — e.g. a legacy `longtext` value that won't
 * cast to `json` because it was truncated under an older `text` column — must NOT crash boot.
 */
function isRequiredStructure(statement: string): boolean {
  return /\b(?:create\s+table|add\s+(?:column|index|constraint|key|unique|fulltext))\b/i.test(
    statement,
  );
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
    try {
      await connection.execute(statement);
    } catch (err) {
      // Required structure (create table / add column / add index) must succeed — rethrow.
      if (isRequiredStructure(statement)) {
        throw err;
      }
      // A best-effort type alignment (e.g. legacy `longtext` → `json`) failed, typically because an
      // existing column holds a value that can't cast to the target type (a relic of an older column
      // type). The column already stores the data and the store reads/writes it via serialization, so
      // leave it as-is and continue rather than crashing boot. Surfaced so the data can be repaired
      // out of band (e.g. `UPDATE … SET col = NULL WHERE JSON_VALID(col) = 0` for a disposable column).
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[nestjs-durable-store-mikro-orm] skipped a non-structural durable-schema statement that failed; the column is left as-is (functional) — repair the data out of band to converge its type. Statement: ${statement} — ${message}`,
      );
    }
  }
}
