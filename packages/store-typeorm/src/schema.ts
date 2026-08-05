import type { DataSource } from 'typeorm';
import {
  BufferedEventEntity,
  BufferedSignalEntity,
  RunAttributeEntity,
  SignalWaiterEntity,
  StepCheckpointEntity,
  WorkflowRunEntity,
} from './entities';

/** The JSON-blob columns per table (keyed by table name) that hold free-form payloads and so must
 *  be the unbounded text type — `longtext` on MySQL, `text` elsewhere. Keyed by entity PROPERTY name;
 *  the physical column is resolved from the DataSource metadata so it tracks the configured naming. */
export const JSON_BLOB_COLUMNS: Record<string, string[]> = {
  durable_workflow_runs: ['input', 'output', 'error', 'tags', 'searchAttributes'],
  durable_step_checkpoints: ['input', 'output', 'error', 'events'],
  // NOTE: durable_buffered_signals/durable_buffered_events intentionally omitted here, same as the
  // existing buffered-signals table — their `payload` column is created with the widened `txt` type
  // (see `${bufCol('payload')} ${txt}` / the new table's `${bevCol('payload')} ${txt}` below) directly
  // at CREATE TABLE time on a fresh install, so there's no pre-existing narrower column to widen.
};

/** Each durable table → its backing entity class, so a column resolver can look up the physical
 *  column for any (table, property) from the DataSource metadata (which reflects the configured
 *  `DurableColumnNaming`). Keeps the raw DDL/SQL in lock-step with the entity column mapping. */
const TABLE_TO_ENTITY = {
  durable_workflow_runs: WorkflowRunEntity,
  durable_step_checkpoints: StepCheckpointEntity,
  durable_run_attributes: RunAttributeEntity,
  durable_signal_waiters: SignalWaiterEntity,
  durable_buffered_signals: BufferedSignalEntity,
  durable_buffered_events: BufferedEventEntity,
} as const;

/**
 * Tables this store creates and manages at boot (autoSchema, see {@link ensureTypeOrmDurableSchema}).
 * Feed to your ORM's migration differ exclude/skipTables so it never tries to drop them.
 *
 * ```ts
 * // MikroORM-flavoured example (TypeORM has no built-in equivalent option); adapt to whichever
 * // migration tool generates your diffs — e.g. exclude these names from a typeorm-generated
 * // migration, or filter them out of `SELECT table_name FROM information_schema.tables` before
 * // diffing against your own entities.
 * const skipTables = new Set(durableManagedTables());
 * ```
 *
 * Derived from the same {@link TABLE_TO_ENTITY} map the raw-SQL heal keys its column resolution off
 * — one list, so a consumer's denylist can never drift from what this store actually owns.
 */
export function durableManagedTables(): string[] {
  return Object.keys(TABLE_TO_ENTITY);
}

/**
 * Resolve `(table, property) => physical column name` from the DataSource's entity metadata. The
 * column names are NOT hardcoded here: they come from whatever the registered `durableEntities`
 * mapped (canonical `snake_case` by default, `'preserve'` for the legacy camelCase, or a custom
 * mapping), so the raw `CREATE TABLE`/index/EXISTS SQL always matches the entities and can never
 * silently diverge.
 */
export function durableColumnResolver(
  dataSource: DataSource,
): (table: string, property: string) => string {
  return (table, property) => {
    const entity = TABLE_TO_ENTITY[table as keyof typeof TABLE_TO_ENTITY];
    if (!entity) throw new Error(`durable store: unknown table "${table}"`);
    const meta = dataSource.getMetadata(entity);
    const column = meta.findColumnWithPropertyName(property);
    if (!column) {
      throw new Error(`durable store: no column for ${table}.${property} in entity metadata`);
    }
    return column.databaseName;
  };
}

/** The SQL type for free-form JSON-blob columns. MySQL `text` caps at 64KB and silently truncates,
 *  so use `longtext` (4GB) there; Postgres/SQLite `text` is already unbounded. */
export function jsonBlobColumnType(isMysql: boolean): 'longtext' | 'text' {
  return isMysql ? 'longtext' : 'text';
}

/** Idempotent `MODIFY COLUMN ... longtext` statements that widen pre-existing MySQL `text` JSON-blob
 *  columns. Returns `[]` on non-MySQL dialects (their `text` is already unbounded — nothing to do).
 *  `quote` quotes an identifier per the active driver; `col` resolves a property to its physical
 *  column name so the widen tracks the configured naming. */
export function buildWidenStatements(
  isMysql: boolean,
  quote: (id: string) => string,
  col: (table: string, property: string) => string,
): string[] {
  if (!isMysql) return [];
  const out: string[] = [];
  for (const [table, props] of Object.entries(JSON_BLOB_COLUMNS)) {
    for (const prop of props) {
      out.push(`ALTER TABLE ${quote(table)} MODIFY COLUMN ${quote(col(table, prop))} longtext`);
    }
  }
  return out;
}

/**
 * Idempotently create the durable tables. Safe to run on every boot (auto-schema) and the
 * exact function to call from your own TypeORM migration when you disable auto-schema:
 *
 * ```ts
 * export class AddDurableTables implements MigrationInterface {
 *   async up(q: QueryRunner) { await ensureTypeOrmDurableSchema(q.connection); }
 * }
 * ```
 *
 * Dialect-aware (MySQL / MariaDB / Postgres / SQLite): identifiers are quoted per driver, keyed
 * string columns are `varchar` (MySQL can't key a `text` column), and the index is best-effort.
 * Only ever adds the three durable tables — it never touches your other tables.
 */
export async function ensureTypeOrmDurableSchema(dataSource: DataSource): Promise<void> {
  const q = (id: string) => dataSource.driver.escape(id);
  // Physical column names come from the entity metadata (canonical snake_case by default), so this
  // raw DDL always matches the registered `durableEntities` instead of hardcoding camelCase.
  const resolve = durableColumnResolver(dataSource);
  const type = String(dataSource.options.type);
  const isPg = type === 'postgres' || type === 'aurora-postgres';
  const isMysql = type === 'mysql' || type === 'mariadb' || type === 'aurora-mysql';
  const isSqlite = type === 'sqlite' || type === 'better-sqlite3' || type === 'expo';

  // Keyed/short strings must be varchar on MySQL (a `text` PK/index needs a key length); `text`
  // for the free-form JSON payloads. Dates use the dialect's native timestamp type.
  const str = 'varchar(191)';
  // Free-form JSON payloads (`input`/`output`/`error`/`events`/`tags`/`searchAttributes`). MySQL's
  // `text` caps at 64KB and *silently truncates* — a large fan-out step's `events` then fails to
  // parse on read ("Unterminated string in JSON"). Use `longtext` (4GB) on MySQL; Postgres `text`
  // is already unbounded and SQLite `text` has no length limit.
  const txt = jsonBlobColumnType(isMysql);
  const int = isMysql ? 'int' : 'integer';
  const ts = isPg ? 'timestamptz' : 'datetime';
  // The tenant partition every poll predicate filters on. NOT NULL with a literal default so that
  // adding it to a table that predates it back-fills each existing row with `'default'` — the
  // namespace those runs actually executed in — instead of leaving NULLs that would match no
  // namespace and so be invisible to every worker. Postgres (11+) and SQLite fill the existing rows
  // from the default without rewriting the table; MySQL 8.0.12+ does it instantly, older MySQL
  // rewrites the table once, so a very large `durable_workflow_runs` there should take the ALTER in a
  // maintenance window rather than at boot.
  const nsCol = `${str} NOT NULL DEFAULT 'default'`;

  const runs = q('durable_workflow_runs');
  const checkpoints = q('durable_step_checkpoints');
  const runAttributes = q('durable_run_attributes');
  const waiters = q('durable_signal_waiters');
  const buffered = q('durable_buffered_signals');
  const bufferedEvents = q('durable_buffered_events');
  // Per-table quoted-column helpers: resolve an entity property to its physical column then quote it.
  const runsCol = (property: string) => q(resolve('durable_workflow_runs', property));
  const cpCol = (property: string) => q(resolve('durable_step_checkpoints', property));
  const attrCol = (property: string) => q(resolve('durable_run_attributes', property));
  const waiterCol = (property: string) => q(resolve('durable_signal_waiters', property));
  const bufCol = (property: string) => q(resolve('durable_buffered_signals', property));
  const bevCol = (property: string) => q(resolve('durable_buffered_events', property));
  // Numeric side-table column for attribute range scans. `double precision` on Postgres, `double` on
  // MySQL, `real` on SQLite (all hold JS numbers without precision loss for the typical attribute).
  const num = isPg ? 'double precision' : isMysql ? 'double' : 'real';

  // Auto-increment PK syntax differs per dialect: SQLite wants `INTEGER PRIMARY KEY AUTOINCREMENT`,
  // MySQL `BIGINT AUTO_INCREMENT PRIMARY KEY`, Postgres `BIGSERIAL PRIMARY KEY`.
  const bufferedId = isSqlite
    ? `${bufCol('id')} integer PRIMARY KEY AUTOINCREMENT`
    : isMysql
      ? `${bufCol('id')} bigint NOT NULL AUTO_INCREMENT PRIMARY KEY`
      : isPg
        ? `${bufCol('id')} bigserial PRIMARY KEY`
        : `${bufCol('id')} bigint NOT NULL AUTO_INCREMENT PRIMARY KEY`;

  const tables = [
    `CREATE TABLE IF NOT EXISTS ${runs} (
      ${runsCol('id')} ${str} PRIMARY KEY,
      ${runsCol('workflow')} ${str} NOT NULL,
      ${runsCol('workflowVersion')} ${str} NOT NULL,
      ${runsCol('status')} ${str} NOT NULL,
      ${runsCol('input')} ${txt}, ${runsCol('output')} ${txt}, ${runsCol('error')} ${txt},
      ${runsCol('wakeAt')} ${ts}, ${runsCol('lockedBy')} ${str}, ${runsCol('lockedUntil')} ${ts},
      ${runsCol('awaitingDecisionTaskId')} ${str},
      ${runsCol('recoveryAttempts')} ${int}, ${runsCol('tags')} ${txt}, ${runsCol('searchAttributes')} ${txt},
      ${runsCol('priority')} ${int}, ${runsCol('namespace')} ${nsCol}, ${runsCol('origin')} ${str},
      ${runsCol('createdAt')} ${ts} NOT NULL, ${runsCol('updatedAt')} ${ts} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${checkpoints} (
      ${cpCol('runId')} ${str} NOT NULL, ${cpCol('seq')} ${int} NOT NULL,
      ${cpCol('name')} ${str} NOT NULL, ${cpCol('kind')} ${str} NOT NULL, ${cpCol('stepId')} ${str} NOT NULL,
      ${cpCol('status')} ${str} NOT NULL, ${cpCol('input')} ${txt}, ${cpCol('output')} ${txt}, ${cpCol('error')} ${txt}, ${cpCol('events')} ${txt},
      ${cpCol('attempts')} ${int} NOT NULL, ${cpCol('workerGroup')} ${str}, ${cpCol('parallelGroup')} ${str},
      ${cpCol('wakeAt')} ${ts}, ${cpCol('enqueuedAt')} ${ts},
      ${cpCol('startedAt')} ${ts} NOT NULL, ${cpCol('finishedAt')} ${ts} NOT NULL,
      PRIMARY KEY (${cpCol('runId')}, ${cpCol('seq')})
    )`,
    // Normalized search-attribute side-table: one row per (run, key) so attribute predicates push
    // DOWN into SQL via an EXISTS join (indexed below). `key` is keyed → must be varchar on MySQL.
    `CREATE TABLE IF NOT EXISTS ${runAttributes} (
      ${attrCol('runId')} ${str} NOT NULL, ${attrCol('key')} ${str} NOT NULL,
      ${attrCol('strValue')} ${str}, ${attrCol('numValue')} ${num},
      PRIMARY KEY (${attrCol('runId')}, ${attrCol('key')})
    )`,
    `CREATE TABLE IF NOT EXISTS ${waiters} (
      ${waiterCol('token')} ${str} PRIMARY KEY, ${waiterCol('runId')} ${str} NOT NULL, ${waiterCol('seq')} ${int} NOT NULL,
      ${waiterCol('parallelGroup')} ${str}
    )`,
    `CREATE TABLE IF NOT EXISTS ${buffered} (
      ${bufferedId}, ${bufCol('token')} ${str} NOT NULL, ${bufCol('payload')} ${txt}
    )`,
    // Caller-minted uuid PK (engine.publishEvent), not auto-increment — unlike durable_buffered_signals
    // above, removeBufferedEvent needs to target the EXACT id it was buffered with.
    `CREATE TABLE IF NOT EXISTS ${bufferedEvents} (
      ${bevCol('id')} ${str} PRIMARY KEY, ${bevCol('name')} ${str} NOT NULL,
      ${bevCol('payload')} ${txt}, ${bevCol('publishedAt')} ${ts} NOT NULL
    )`,
  ];

  // Additive nullable columns gained across versions (e.g. `input`, `events`, `enqueuedAt`). On a
  // table that predates them, `CREATE TABLE IF NOT EXISTS` above is a no-op, so back-fill the ones
  // that are actually missing — the auto-schema self-heals instead of needing a manual migration.
  // We check the live columns first (rather than ALTER-and-ignore) so a *real* ALTER failure
  // surfaces instead of being swallowed as a presumed "column already exists".
  // Keyed by entity PROPERTY name; the physical column is resolved per-table so the ADD COLUMN
  // tracks the configured naming.
  const additive: Record<string, Array<[string, string]>> = {
    durable_workflow_runs: [
      ['input', txt],
      ['output', txt],
      ['error', txt],
      ['awaitingDecisionTaskId', str],
      ['recoveryAttempts', int],
      ['tags', txt],
      ['searchAttributes', txt],
      ['priority', int],
      // Back-filled WITH a value, unlike `origin` below: the DDL default writes `'default'` onto
      // every pre-existing row, because a run created before this column existed really did execute
      // in the unscoped `'default'` namespace. Leaving those rows NULL would make them invisible to
      // the worker that owns them — the list predicates are plain equality, so `NULL <> 'default'`.
      ['namespace', nsCol],
      // Nullable and NOT back-filled with a value: every row that predates the column keeps a NULL
      // origin, which the store reads as `undefined` = "unknown origin". There is no honest value to
      // back-fill — the origin is derived from the registration that created the run, which is long
      // gone by the time this ALTER runs.
      ['origin', str],
    ],
    durable_step_checkpoints: [
      ['input', txt],
      ['output', txt],
      ['error', txt],
      ['events', txt],
      ['workerGroup', str],
      ['parallelGroup', str],
      ['enqueuedAt', ts],
    ],
    // Back-fill the child-await fan group onto signal-waiter tables that predate it (a remote
    // `gather_children` fan-out threads its group here so the resolved `signal:child:` checkpoint carries it).
    durable_signal_waiters: [['parallelGroup', str]],
  };

  const runner = dataSource.createQueryRunner();
  try {
    for (const sql of tables) await runner.query(sql);
    for (const [table, props] of Object.entries(additive)) {
      const have = await existingColumns(runner, table, { isSqlite, isMysql });
      for (const [property, colType] of props) {
        const column = resolve(table, property);
        if (!have.has(column)) {
          await runner.query(`ALTER TABLE ${q(table)} ADD COLUMN ${q(column)} ${colType}`);
        }
      }
    }
    // Widen pre-existing MySQL `text` JSON-blob columns to `longtext`. A table created before this
    // fix has these as `text` (64KB) and silently truncates large `events`/`output` payloads. MODIFY
    // to `longtext` is idempotent (no-op if already longtext), so it's safe to run on every boot.
    // MySQL-only: Postgres/SQLite `text` is already unbounded, so there's nothing to widen.
    for (const sql of buildWidenStatements(isMysql, q, resolve)) {
      try {
        await runner.query(sql);
      } catch {
        /* column already longtext, or table/column not present on this deploy */
      }
    }
    // MySQL has no `CREATE INDEX IF NOT EXISTS`; create each best-effort and ignore "already exists".
    //  - status/wakeAt: the timer poller (listDueTimers) and recovery (listIncompleteRuns) scans.
    //  - workflow/status: the dashboard's listRuns filters. (Checkpoints are keyed by the PK prefix
    //    `(runId, seq)`, so listCheckpoints/getEvent already hit an index — no extra one needed.)
    const indexes: Array<[string, string]> = [
      ['durable_runs_status_idx', `${runs} (${runsCol('status')}, ${runsCol('wakeAt')})`],
      [
        'durable_runs_workflow_status_idx',
        `${runs} (${runsCol('workflow')}, ${runsCol('status')})`,
      ],
      // namespace/status/createdAt: every poll tick of a namespaced worker filters on `namespace`
      // ANDed with `status` (and `listPendingRuns` orders by `createdAt`), so without this the two
      // indexes above degrade to a scan of the WHOLE table — including every other tenant's rows —
      // on each tick. Created best-effort on every boot like the others, so a deployment whose table
      // already exists picks it up as soon as it runs this version.
      [
        'durable_runs_namespace_status_idx',
        `${runs} (${runsCol('namespace')}, ${runsCol('status')}, ${runsCol('createdAt')})`,
      ],
      // buffered signals are taken FIFO per token (smallest id) — index the token for the scan.
      ['durable_buffered_signals_token_idx', `${buffered} (${bufCol('token')})`],
      // buffered events are scanned oldest-first per name — one composite index serves both.
      [
        'durable_buffered_events_name_published_at_idx',
        `${bufferedEvents} (${bevCol('name')}, ${bevCol('publishedAt')})`,
      ],
      // Search-attribute pushdown: equality + range predicates probe by (key, value). Two composite
      // indexes — one per typed column — so a numeric range or a string equality is an index scan.
      [
        'durable_run_attributes_num_idx',
        `${runAttributes} (${attrCol('key')}, ${attrCol('numValue')})`,
      ],
      [
        'durable_run_attributes_str_idx',
        `${runAttributes} (${attrCol('key')}, ${attrCol('strValue')})`,
      ],
    ];
    for (const [name, target] of indexes) {
      try {
        await runner.query(`CREATE INDEX ${q(name)} ON ${target}`);
      } catch {
        /* index already exists */
      }
    }
  } finally {
    await runner.release();
  }
}

/** The columns that currently exist on `table`, so the schema can add only the missing ones
 *  (instead of ALTER-and-swallow, which would also hide a genuine ALTER failure). */
async function existingColumns(
  runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  table: string,
  d: { isSqlite: boolean; isMysql: boolean },
): Promise<Set<string>> {
  if (d.isSqlite) {
    const rows = (await runner.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  }
  // Postgres + MySQL both expose information_schema; scope to the connection's own schema/db.
  // Bind-param placeholder differs: Postgres uses `$1`, MySQL uses `?` (TypeORM only rewrites `?`
  // inside the query builder, not for these raw `runner.query` calls), so pick per dialect.
  const scope = d.isMysql ? 'TABLE_SCHEMA = DATABASE()' : 'table_schema = current_schema()';
  const placeholder = d.isMysql ? '?' : '$1';
  const rows = (await runner.query(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ${placeholder} AND ${scope}`,
    [table],
  )) as Array<{ name?: string; COLUMN_NAME?: string }>;
  return new Set(rows.map((r) => (r.name ?? r.COLUMN_NAME) as string));
}
