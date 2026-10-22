import { createHash } from 'node:crypto';
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
  'durable_buffered_events',
  'durable_schedules',
]);

/**
 * Tables this store creates and manages at boot (autoSchema). Feed to your ORM's migration differ
 * exclude/skipTables so it never tries to drop them.
 *
 * ```ts
 * await MikroORM.init({
 *   // ...your entities/driver config
 *   schemaGenerator: { skipTables: durableManagedTables() },
 * });
 * ```
 *
 * Derived from the same {@link DURABLE_TABLE_NAMES} set `ensureMikroOrmDurableSchema` scopes its own
 * heal to — one list, so a consumer's denylist can never drift from what this store actually owns.
 */
export function durableManagedTables(): string[] {
  return [...DURABLE_TABLE_NAMES];
}

/**
 * Marker table that records the fingerprint of the durable schema last applied to this database. A
 * single row (`id = 'durable'`) lets every boot decide — with two cheap round-trips — whether the
 * durable tables already match the entity metadata, so steady-state boots skip the expensive
 * whole-app introspection (`getUpdateSchemaSQL`) and per-table collation probes entirely.
 */
const MARKER_TABLE = 'durable_schema_meta';
const MARKER_ROW_ID = 'durable';

/** The advisory-lock name used to serialize the heal across pods (MySQL `GET_LOCK` / PG advisory). */
const SCHEMA_LOCK_NAME = 'durable_schema';

/**
 * Hand-bump escape hatch for DDL changes that are NOT visible in the entity metadata and so wouldn't
 * change the computed fingerprint on their own — e.g. the collation-alignment logic in
 * {@link alignDurableCollation}, or a change to the heal's filtering. Bumping this value changes every
 * computed fingerprint, which forces a one-time re-heal on the next boot of every pod against every
 * database (the stored marker no longer matches), then settles back to the cheap steady-state path.
 */
const SCHEMA_REVISION = 1;

/**
 * Where {@link ensureMikroOrmDurableSchema} reports a schema repair it actually applied. `console`
 * (the default) satisfies it, and so does NestJS's `Logger`, so an app can route the warning into
 * its own log stream.
 */
export interface DurableSchemaLogger {
  warn(message: string): void;
}

export interface EnsureMikroOrmDurableSchemaOptions {
  /** Sink for the schema-repair warning. Defaults to `console`. */
  logger?: DurableSchemaLogger | undefined;
}

/**
 * The warning logged when the boot-time heal changed an EXISTING durable schema: created a table
 * that was missing next to ones that exist, added a column or index, changed a column type, or
 * converted a table's collation. Never logged when the schema was already current, and never on a
 * fresh install (no durable table existed, so creating them all is the expected first boot).
 *
 * The discriminator matters more than the wording: a warning on every boot would be filtered as
 * noise, and a silent repair hides a migration-managed schema that has drifted from the library.
 */
export function mikroOrmSchemaRepairWarning(repairs: readonly string[]): string {
  return [
    `[nestjs-durable] store-mikro-orm repaired the durable schema at boot: ${repairs.join('; ')}.`,
    'The database had drifted from the schema this library version expects (it was created by an',
    'older version, or a migration left these out), so they were applied at runtime and nothing',
    'recorded them in your migration history. To make them permanent, add a migration that calls',
    '`ensureMikroOrmDurableSchema(orm)`. This warning appears only when a repair was applied; a',
    'schema that is already current logs nothing.',
  ].join(' ');
}

/** Strip identifier quotes (`"x"`, `` `x` ``, `'x'`) from a DDL token. */
function unquote(identifier: string): string {
  return identifier.replace(/^[`"']|[`"']$/g, '');
}

/**
 * A short, human description of one applied durable-table DDL statement, for the repair warning.
 * Recognizes the shapes MikroORM's safe diff emits (create table / create index / alter table … add
 * column / add index / add constraint); anything else (a type change) is quoted, trimmed.
 */
function describeDurableStatement(statement: string): string[] {
  const table = targetTable(statement) ?? '?';
  if (/^create\s+table\b/i.test(statement)) return [`created table ${table}`];
  const createIndex = statement.match(
    /^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([`"']?[\w$]+[`"']?)/i,
  );
  if (createIndex?.[1]) return [`created index ${unquote(createIndex[1])} on ${table}`];
  if (/^alter\s+table\b/i.test(statement)) {
    const out: string[] = [];
    let other = false;
    // Split the alter's comma-separated actions at top level (a column type may carry `(10,2)`).
    for (const action of splitTopLevel(
      statement.replace(/^alter\s+table\s+[`"']?[\w$]+[`"']?\s*/i, ''),
    )) {
      const index = action.match(
        /^add\s+(?:unique\s+|fulltext\s+)?(?:index|key)\s+([`"']?[\w$]+[`"']?)/i,
      );
      const constraint = action.match(/^add\s+constraint\s+([`"']?[\w$]+[`"']?)/i);
      const column = action.match(/^add\s+(?:column\s+)?([`"']?[\w$]+[`"']?)/i);
      if (index?.[1]) out.push(`created index ${unquote(index[1])} on ${table}`);
      else if (constraint?.[1]) out.push(`added constraint ${unquote(constraint[1])} on ${table}`);
      else if (column?.[1] && !/^add\s+(?:primary|unique|fulltext|foreign)\b/i.test(action))
        out.push(`added column ${table}.${unquote(column[1])}`);
      else other = true;
    }
    if (other || out.length === 0) {
      const flat = statement.replace(/\s+/g, ' ');
      out.push(`altered ${table} (${flat.length > 160 ? `${flat.slice(0, 157)}...` : flat})`);
    }
    return out;
  }
  return [`ran ${statement.replace(/\s+/g, ' ').slice(0, 160)}`];
}

/** Split on commas that are not inside parentheses or quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** A JSON value the canonical serializer understands. No `any`: the fingerprint input is plain data. */
type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

/** The SQL dialect, derived from the ORM platform, used to branch the lock + marker-table DDL/upsert. */
type SqlDialect = 'mysql' | 'postgres' | 'sqlite' | 'unknown';

/** Stable string compare (locale-independent) so sorted serializations are deterministic. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The table a DDL statement targets, lower-cased; undefined otherwise. Recognizes `create table` /
 * `alter table` (the table name follows immediately) and standalone `create [unique] index ... on
 * <table>` (the table follows `on`). MikroORM adds an index to an EXISTING table as `alter table ...
 * add index` on MySQL but as a standalone `create index ... on ...` on Postgres/SQLite — without the
 * second form those index statements would be dropped by the durable-table filter and never applied.
 */
function targetTable(statement: string): string | undefined {
  const match = statement.match(
    /^(?:create\s+(?:unique\s+)?index\s+.+?\s+on\s+|(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?)[`"']?([\w$]+)[`"']?/i,
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
  return /\b(?:create\s+table|create\s+(?:unique\s+)?index|add\s+(?:column|index|constraint|key|unique|fulltext))\b/i.test(
    statement,
  );
}

/** Map the ORM's platform class name onto the dialect we branch lock + DDL syntax on. */
function detectSqlDialect(orm: MikroORM): SqlDialect {
  const platform = String(orm.em.getPlatform().constructor.name).toLowerCase();
  if (platform.includes('mysql') || platform.includes('maria')) return 'mysql';
  if (platform.includes('postgre')) return 'postgres';
  if (platform.includes('sqlite') || platform.includes('libsql')) return 'sqlite';
  return 'unknown';
}

/** Normalize a MikroORM index `properties` value (string | string[] | undefined) to an array. */
function normalizeIndexProperties(properties: string | string[] | undefined): string[] {
  if (properties === undefined) return [];
  if (Array.isArray(properties)) return properties.map((property) => String(property));
  return [String(properties)];
}

/**
 * A content fingerprint of the durable tables AS DESCRIBED BY THE ENTITY METADATA — pure, in-memory,
 * no database round-trip. Filters the ORM metadata to the tables this store owns, builds a CANONICAL
 * (sorted tables, sorted columns, sorted indexes, sorted object keys) serialization of each table's
 * structural shape, then appends the configured `collate` and {@link SCHEMA_REVISION} and hashes it.
 *
 * Object enumeration order is never trusted — every array is sorted and every object key is sorted by
 * the serializer — so the same metadata always yields the same hash regardless of declaration order.
 * A change to any column/index/type/nullability/default, the configured collation, or the revision
 * changes the hash, which is exactly when the stored marker should be considered stale and re-healed.
 */
function computeExpectedFingerprint(orm: MikroORM, ownedTableNames: Set<string>): string {
  const ownedMetadata = [...orm.getMetadata().getAll().values()]
    .filter((meta) => ownedTableNames.has(meta.tableName))
    .sort((a, b) => compareStrings(a.tableName, b.tableName));

  const tables: JsonValue = ownedMetadata.map((meta) => {
    const columns: JsonValue = [...meta.props]
      .map((prop) => ({ prop, columnName: prop.fieldNames[0] ?? String(prop.name) }))
      .sort((a, b) => compareStrings(a.columnName, b.columnName))
      .map(({ prop, columnName }) => ({
        name: columnName,
        type: prop.columnTypes[0] ?? String(prop.type),
        nullable: prop.nullable === true,
        primary: prop.primary === true,
        default: prop.default ?? null,
        autoincrement: prop.autoincrement === true,
      }));

    const indexes: JsonValue = [...meta.indexes]
      .map((index) => ({
        name: index.name ?? '',
        properties: normalizeIndexProperties(index.properties),
      }))
      .sort((a, b) => compareStrings(a.name, b.name));

    return { tableName: meta.tableName, columns, indexes };
  });

  const canonical = `${canonicalize(tables)}|collate=${String(orm.config.get('collate') ?? '')}|rev=${SCHEMA_REVISION}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/** Deterministic JSON: arrays keep order (already sorted by the caller); object keys are sorted. */
function canonicalize(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => compareStrings(a, b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `CREATE TABLE IF NOT EXISTS` for the marker — portable across MySQL/Postgres/SQLite, no introspection. */
function createMarkerTableSql(): string {
  return `create table if not exists ${MARKER_TABLE} (id varchar(32) not null primary key, fingerprint varchar(64) not null, applied_at bigint not null)`;
}

/** Read the single marker row's fingerprint (one PK lookup), or undefined when the row is absent. */
async function readStoredFingerprint(orm: MikroORM): Promise<string | undefined> {
  const rows: Array<{ fingerprint?: string | null }> = await orm.em
    .getConnection()
    .execute(`select fingerprint from ${MARKER_TABLE} where id = ?`, [MARKER_ROW_ID]);
  return rows[0]?.fingerprint ?? undefined;
}

/** Upsert the marker row with the new fingerprint + apply time (epoch-ms bigint, driver-portable). */
async function writeFingerprint(
  orm: MikroORM,
  dialect: SqlDialect,
  fingerprint: string,
): Promise<void> {
  const upsert =
    dialect === 'mysql'
      ? `insert into ${MARKER_TABLE} (id, fingerprint, applied_at) values (?, ?, ?) on duplicate key update fingerprint = values(fingerprint), applied_at = values(applied_at)`
      : `insert into ${MARKER_TABLE} (id, fingerprint, applied_at) values (?, ?, ?) on conflict (id) do update set fingerprint = excluded.fingerprint, applied_at = excluded.applied_at`;
  await orm.em.getConnection().execute(upsert, [MARKER_ROW_ID, fingerprint, Date.now()]);
}

/**
 * Best-effort cross-pod lock around the heal: MySQL `GET_LOCK`, Postgres `pg_advisory_lock`. Skipped
 * on SQLite/unknown drivers (single-writer / no portable advisory lock). A failure to acquire — lock
 * unsupported, timed out, permission denied — is warned and swallowed so the heal still proceeds; the
 * heal itself is idempotent (additive DDL + a re-check of the fingerprint after acquiring).
 */
async function acquireSchemaLock(orm: MikroORM, dialect: SqlDialect): Promise<void> {
  try {
    if (dialect === 'mysql') {
      await orm.em.getConnection().execute(`select get_lock('${SCHEMA_LOCK_NAME}', 10)`);
    } else if (dialect === 'postgres') {
      await orm.em
        .getConnection()
        .execute(`select pg_advisory_lock(hashtext('${SCHEMA_LOCK_NAME}'))`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[nestjs-durable-store-mikro-orm] could not acquire the durable-schema advisory lock (proceeding without it): ${message}`,
    );
  }
}

/** Release the advisory lock acquired by {@link acquireSchemaLock} (best-effort, never throws). */
async function releaseSchemaLock(orm: MikroORM, dialect: SqlDialect): Promise<void> {
  try {
    if (dialect === 'mysql') {
      await orm.em.getConnection().execute(`select release_lock('${SCHEMA_LOCK_NAME}')`);
    } else if (dialect === 'postgres') {
      await orm.em
        .getConnection()
        .execute(`select pg_advisory_unlock(hashtext('${SCHEMA_LOCK_NAME}'))`);
    }
  } catch {
    // Releasing a lock we may never have held (acquire was best-effort) must not crash boot.
  }
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
 *
 * This runs on every boot of every pod, and `getUpdateSchemaSQL({ safe: true })` introspects the
 * WHOLE database's `information_schema` (the store shares the app ORM) before string-filtering down
 * to our tables — wasted round-trips when nothing changed. So a fingerprint GATE fronts it: a marker
 * table records the fingerprint of the metadata last applied; if the in-memory expected fingerprint
 * matches the stored one we return after two cheap round-trips (a `CREATE TABLE IF NOT EXISTS` for
 * the marker + one PK read), skipping BOTH the introspection AND the collation probes. Only a fresh
 * DB (no marker), an entity change, or a {@link SCHEMA_REVISION} bump runs the full heal — under a
 * best-effort advisory lock, with a re-check in case a sibling pod healed while we waited.
 *
 * When the heal changes an existing durable schema (a missing table, column or index, a column type,
 * a MySQL collation), it logs ONE warning listing each change to `options.logger` (default
 * `console`); see {@link mikroOrmSchemaRepairWarning}. A current schema and a fresh install log
 * nothing. Because of the fingerprint gate, a column dropped by hand AFTER the marker was written is
 * not noticed until the fingerprint changes (an upgrade) or the marker row is deleted.
 */
export async function ensureMikroOrmDurableSchema(
  orm: MikroORM,
  options: EnsureMikroOrmDurableSchemaOptions = {},
): Promise<void> {
  const logger = options.logger ?? console;
  const dialect = detectSqlDialect(orm);

  // 1. Bootstrap the marker table. Idempotent, no introspection — works on a brand-new empty DB,
  //    which is what makes the fresh-DB / CI path zero-config.
  await orm.em.getConnection().execute(createMarkerTableSql());

  // 2. Compare the in-memory expected fingerprint against the stored one (a single PK read).
  const expected = computeExpectedFingerprint(orm, DURABLE_TABLE_NAMES);
  const stored = await readStoredFingerprint(orm);

  // 3. Steady-state hot path: nothing changed → skip getUpdateSchemaSQL AND alignDurableCollation.
  if (stored === expected) {
    return;
  }

  // 4. Heal under a best-effort cross-pod lock; re-check after acquiring in case a peer healed first.
  await acquireSchemaLock(orm, dialect);
  try {
    if ((await readStoredFingerprint(orm)) === expected) {
      return;
    }
    const { repairs, freshInstall } = await healDurableSchema(orm);
    await writeFingerprint(orm, dialect, expected);
    if (repairs.length > 0 && !freshInstall) logger.warn(mikroOrmSchemaRepairWarning(repairs));
  } finally {
    await releaseSchemaLock(orm, dialect);
  }
}

/**
 * The additive heal itself: compute the safe diff, execute only the statements targeting our durable
 * tables, then converge their collation. Extracted from {@link ensureMikroOrmDurableSchema} so the
 * fingerprint gate can skip it wholesale in steady state. Returns what it changed (for the repair
 * warning) and whether this was a fresh install (every durable table created by this heal).
 */
async function healDurableSchema(
  orm: MikroORM,
): Promise<{ repairs: string[]; freshInstall: boolean }> {
  const sql = await orm.schema.getUpdateSchemaSQL({ safe: true });
  const ours = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => {
      const table = targetTable(statement);
      return table !== undefined && DURABLE_TABLE_NAMES.has(table);
    });
  const connection = orm.em.getConnection();
  // Tables this heal creates: their indexes come with them, so they are not listed one by one.
  const created = new Set(
    ours
      .filter((statement) => /^create\s+table\b/i.test(statement))
      .map((statement) => targetTable(statement) as string),
  );
  const repairs: string[] = [];
  for (const statement of ours) {
    try {
      await connection.execute(statement);
      const table = targetTable(statement) as string;
      const isCreateTable = /^create\s+table\b/i.test(statement);
      if (isCreateTable || !created.has(table))
        repairs.push(...describeDurableStatement(statement));
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

  // Converge collation last, once the tables exist (whether just created above or pre-existing).
  const converted = await alignDurableCollation(orm);
  for (const { table, from, to } of converted) {
    if (!created.has(table)) repairs.push(`converted ${table} collation from ${from} to ${to}`);
  }
  const freshInstall = [...DURABLE_TABLE_NAMES].every((table) => created.has(table));
  return { repairs, freshInstall };
}

/** A MySQL identifier we are willing to interpolate into DDL (charset / collation names). */
function isSafeSqlIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

/**
 * Align each durable table's collation to the ORM's configured `collate` (MySQL/MariaDB only).
 *
 * MikroORM's auto-schema (`getUpdateSchemaSQL`) creates tables with the server's DEFAULT collation —
 * on MySQL 8.4 that's `utf8mb4_0900_ai_ci` — and ignores the `collate` config option. When the host
 * app pins a different collation on its own tables (commonly `utf8mb4_unicode_ci` via migrations), a
 * JOIN between a durable table and an app table throws "Illegal mix of collations". We converge it
 * here: read the configured collation and `CONVERT` only the durable tables whose collation differs.
 *
 * Idempotent (matching tables are skipped), non-fatal (a CONVERT failure is warned, never crashes
 * boot), and a no-op when no `collate` is configured or the platform isn't MySQL/MariaDB. Returns
 * the tables it converted.
 */
async function alignDurableCollation(
  orm: MikroORM,
): Promise<Array<{ table: string; from: string; to: string }>> {
  const converted: Array<{ table: string; from: string; to: string }> = [];
  const platform = String(orm.em.getPlatform().constructor.name).toLowerCase();
  if (!platform.includes('mysql') && !platform.includes('maria')) {
    return converted;
  }
  const collate = orm.config.get('collate');
  if (typeof collate !== 'string' || !isSafeSqlIdentifier(collate)) {
    return converted;
  }
  // utf8mb4_unicode_ci → utf8mb4. CONVERT TO needs the charset that owns the collation.
  const charset = collate.split('_')[0];
  if (!charset || !isSafeSqlIdentifier(charset)) {
    return converted;
  }
  const connection = orm.em.getConnection();
  for (const table of DURABLE_TABLE_NAMES) {
    try {
      const rows = (await connection.execute(
        'select table_collation as collation from information_schema.tables where table_schema = database() and table_name = ? limit 1',
        [table],
      )) as Array<{ collation?: string | null }>;
      const current = rows[0]?.collation;
      // Table absent (nothing to align) or already at the target collation — skip.
      if (current == null || current === collate) {
        continue;
      }
      await connection.execute(
        `alter table \`${table}\` convert to character set ${charset} collate ${collate}`,
      );
      converted.push({ table, from: current, to: collate });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[nestjs-durable-store-mikro-orm] could not align collation for \`${table}\` to ${collate} (left as-is): ${message}`,
      );
    }
  }
  return converted;
}
