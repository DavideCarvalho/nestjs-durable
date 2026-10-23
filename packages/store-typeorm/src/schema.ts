import type { DataSource } from 'typeorm';
import {
  BufferedEventEntity,
  BufferedSignalEntity,
  RunAttributeEntity,
  ScheduleEntity,
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

/**
 * Fractional-second digits on every MySQL timestamp column. A bare `datetime` holds whole seconds
 * and ROUNDS the milliseconds away, which moves leases, timers and event order by up to half a
 * second. 6 matches Postgres's `timestamptz` and the MikroORM store's MySQL columns.
 */
export const MYSQL_DATETIME_TYPE = 'datetime(6)';

/** The timestamp columns per table (entity PROPERTY names), raised to {@link MYSQL_DATETIME_TYPE}. */
const DATETIME_COLUMNS: Record<string, string[]> = {
  durable_workflow_runs: ['wakeAt', 'lockedUntil', 'createdAt', 'updatedAt'],
  durable_step_checkpoints: ['wakeAt', 'enqueuedAt', 'startedAt', 'finishedAt'],
  durable_buffered_events: ['publishedAt'],
  durable_schedules: ['createdAt', 'updatedAt'],
};

/** Default {@link EnsureTypeOrmDurableSchemaOptions.blockingAlterRowLimit}: a copy of this many rows takes seconds. */
export const DEFAULT_BLOCKING_ALTER_ROW_LIMIT = 100_000;

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
  durable_schedules: ScheduleEntity,
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
 * Where {@link ensureTypeOrmDurableSchema} reports a schema repair it actually applied. `console`
 * (the default) satisfies it, and so does NestJS's `Logger`, so an app can route the warning into
 * its own log stream.
 */
export interface DurableSchemaLogger {
  warn(message: string): void;
}

export interface EnsureTypeOrmDurableSchemaOptions {
  /** Sink for the schema-repair warning. Defaults to `console`. */
  logger?: DurableSchemaLogger | undefined;
  /**
   * MySQL only: the largest estimated row count (`information_schema.tables.table_rows`) of an
   * existing durable table on which the boot-time check will raise a timestamp column's precision.
   * MySQL runs that type change as a full table copy that blocks writes until it finishes, so on a
   * bigger table the statement is skipped and logged for you to run out of band (a maintenance
   * window, `gh-ost`, `pt-online-schema-change`); every boot logs it again until the column matches.
   * Defaults to {@link DEFAULT_BLOCKING_ALTER_ROW_LIMIT}. `Infinity` always applies.
   */
  blockingAlterRowLimit?: number | undefined;
}

/** The warning logged when a precision upgrade was skipped because the table is too big to rebuild at boot. */
export function typeOrmDeferredAlterWarning(
  deferred: ReadonlyArray<{ table: string; rows: number; statement: string }>,
  limit: number,
): string {
  return [
    '[nestjs-durable] store-typeorm did NOT apply these durable-schema column type changes at boot,',
    `because MySQL rebuilds the table and blocks its writes while it does, and each table holds more than ${limit} rows:`,
    deferred.map((d) => `${d.table} (~${d.rows} rows): ${d.statement};`).join(' '),
    'Run them in a maintenance window or with an online schema change tool (gh-ost,',
    'pt-online-schema-change), or raise `blockingAlterRowLimit`. Until then the store keeps working on',
    'the old column types, and this warning repeats on every boot.',
  ].join(' ');
}

/**
 * The warning logged when the boot-time schema check changed an EXISTING durable schema: created a
 * table that was missing next to ones that exist, added a column, created an index, or widened a
 * column. Never logged when the schema was already current, and never on a fresh install (no
 * durable table existed yet, so creating them all is the expected first boot, not a drift).
 *
 * The discriminator matters more than the wording: a warning on every boot would be filtered as
 * noise, and a silent repair hides a migration-managed schema that has drifted from the library.
 */
export function typeOrmSchemaRepairWarning(repairs: readonly string[]): string {
  return [
    `[nestjs-durable] store-typeorm repaired the durable schema at boot: ${repairs.join('; ')}.`,
    'The database had drifted from the schema this library version expects (it was created by an',
    'older version, or a migration left these out), so they were applied at runtime and nothing',
    'recorded them in your migration history. To make them permanent, add a migration that calls',
    '`ensureTypeOrmDurableSchema(queryRunner.connection)`. This warning appears only when a repair',
    'was applied; a schema that is already current logs nothing.',
  ].join(' ');
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
 * Only ever adds the durable tables — it never touches your other tables.
 *
 * When it changes an existing durable schema (a missing table, column or index, a MySQL JSON column
 * still `text`), it logs ONE warning listing each change to `options.logger` (default `console`);
 * see {@link typeOrmSchemaRepairWarning}. A current schema and a fresh install log nothing.
 */
export async function ensureTypeOrmDurableSchema(
  dataSource: DataSource,
  options: EnsureTypeOrmDurableSchemaOptions = {},
): Promise<void> {
  const logger = options.logger ?? console;
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
  const ts = isPg ? 'timestamptz' : isMysql ? MYSQL_DATETIME_TYPE : 'datetime';
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
  const schedules = q('durable_schedules');
  const schCol = (property: string) => q(resolve('durable_schedules', property));
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

  const tables: Array<[string, string]> = [
    [
      'durable_workflow_runs',
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
    ],
    [
      'durable_step_checkpoints',
      `CREATE TABLE IF NOT EXISTS ${checkpoints} (
      ${cpCol('runId')} ${str} NOT NULL, ${cpCol('seq')} ${int} NOT NULL,
      ${cpCol('name')} ${str} NOT NULL, ${cpCol('kind')} ${str} NOT NULL, ${cpCol('stepId')} ${str} NOT NULL,
      ${cpCol('status')} ${str} NOT NULL, ${cpCol('input')} ${txt}, ${cpCol('output')} ${txt}, ${cpCol('error')} ${txt}, ${cpCol('events')} ${txt},
      ${cpCol('attempts')} ${int} NOT NULL, ${cpCol('workerGroup')} ${str}, ${cpCol('parallelGroup')} ${str},
      ${cpCol('wakeAt')} ${ts}, ${cpCol('enqueuedAt')} ${ts},
      ${cpCol('startedAt')} ${ts} NOT NULL, ${cpCol('finishedAt')} ${ts} NOT NULL,
      PRIMARY KEY (${cpCol('runId')}, ${cpCol('seq')})
    )`,
    ],
    // Normalized search-attribute side-table: one row per (run, key) so attribute predicates push
    // DOWN into SQL via an EXISTS join (indexed below). `key` is keyed → must be varchar on MySQL.
    [
      'durable_run_attributes',
      `CREATE TABLE IF NOT EXISTS ${runAttributes} (
      ${attrCol('runId')} ${str} NOT NULL, ${attrCol('key')} ${str} NOT NULL,
      ${attrCol('strValue')} ${str}, ${attrCol('numValue')} ${num},
      PRIMARY KEY (${attrCol('runId')}, ${attrCol('key')})
    )`,
    ],
    [
      'durable_signal_waiters',
      `CREATE TABLE IF NOT EXISTS ${waiters} (
      ${waiterCol('token')} ${str} PRIMARY KEY, ${waiterCol('runId')} ${str} NOT NULL, ${waiterCol('seq')} ${int} NOT NULL,
      ${waiterCol('parallelGroup')} ${str}
    )`,
    ],
    [
      'durable_buffered_signals',
      `CREATE TABLE IF NOT EXISTS ${buffered} (
      ${bufferedId}, ${bufCol('token')} ${str} NOT NULL, ${bufCol('payload')} ${txt}
    )`,
    ],
    // Caller-minted uuid PK (engine.publishEvent), not auto-increment — unlike durable_buffered_signals
    // above, removeBufferedEvent needs to target the EXACT id it was buffered with.
    [
      'durable_buffered_events',
      `CREATE TABLE IF NOT EXISTS ${bufferedEvents} (
      ${bevCol('id')} ${str} PRIMARY KEY, ${bevCol('name')} ${str} NOT NULL,
      ${bevCol('payload')} ${txt}, ${bevCol('publishedAt')} ${ts} NOT NULL
    )`,
    ],
    // Persisted schedules. `next_fire_at` is epoch ms as a bigint (exact, so the compare-and-set on
    // it survives MySQL's DATETIME millisecond truncation); `spec`/`state` are engine-owned JSON.
    [
      'durable_schedules',
      `CREATE TABLE IF NOT EXISTS ${schedules} (
      ${schCol('id')} ${str} PRIMARY KEY, ${schCol('namespace')} ${nsCol},
      ${schCol('workflow')} ${str} NOT NULL,
      ${schCol('paused')} boolean NOT NULL DEFAULT ${isPg ? 'false' : '0'},
      ${schCol('nextFireAt')} bigint, ${schCol('tags')} ${txt},
      ${schCol('spec')} ${txt} NOT NULL, ${schCol('state')} ${txt} NOT NULL,
      ${schCol('createdAt')} ${ts} NOT NULL, ${schCol('updatedAt')} ${ts} NOT NULL
    )`,
    ],
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

  // What this boot actually changed, for the repair warning. Tables created here are recorded
  // separately: their columns and indexes come with the CREATE, so they are not listed one by one.
  const repairs: string[] = [];
  const deferred: Array<{ table: string; rows: number; statement: string }> = [];
  const rowLimit = options.blockingAlterRowLimit ?? DEFAULT_BLOCKING_ALTER_ROW_LIMIT;
  const created = new Set<string>();
  const runner = dataSource.createQueryRunner();
  try {
    const before = await existingTables(runner, { isSqlite, isMysql });
    for (const [table, sql] of tables) {
      await runner.query(sql);
      if (!before.has(table)) {
        created.add(table);
        repairs.push(`created table ${table}`);
      }
    }
    for (const [table, props] of Object.entries(additive)) {
      const have = await existingColumns(runner, table, { isSqlite, isMysql });
      for (const [property, colType] of props) {
        const column = resolve(table, property);
        if (!have.has(column)) {
          await runner.query(`ALTER TABLE ${q(table)} ADD COLUMN ${q(column)} ${colType}`);
          repairs.push(`added column ${table}.${column}`);
        }
      }
    }
    // Widen pre-existing MySQL `text` JSON-blob columns to `longtext`. A table created before this
    // fix has these as `text` (64KB) and silently truncates large `events`/`output` payloads. MODIFY
    // to `longtext` only for the columns that are not `longtext` yet, so a current schema issues no
    // ALTER (and a widen is reported only when one ran).
    // MySQL-only: Postgres/SQLite `text` is already unbounded, so there's nothing to widen.
    if (isMysql) {
      for (const [table, props] of Object.entries(JSON_BLOB_COLUMNS)) {
        const types = await mysqlColumnTypes(runner, table);
        for (const prop of props) {
          const column = resolve(table, prop);
          const current = types.get(column);
          if (current === undefined || current === 'longtext') continue;
          try {
            await runner.query(
              `ALTER TABLE ${q(table)} MODIFY COLUMN ${q(column)} ${jsonBlobColumnType(true)}`,
            );
            repairs.push(`widened ${table}.${column} from ${current} to longtext`);
          } catch {
            /* best-effort, as before: a failed widen leaves the column as it was */
          }
        }
      }
    }
    // Raise second-precision MySQL timestamp columns (what older versions created) to
    // `datetime(6)`, one ALTER per table, keeping each column's nullability. A type change is a
    // blocking table copy on MySQL, so a table above the row limit is deferred to the operator.
    if (isMysql) {
      for (const [table, props] of Object.entries(DATETIME_COLUMNS)) {
        if (created.has(table)) continue;
        const columns = await mysqlDatetimeColumns(runner, table);
        const behind = props
          .map((prop) => resolve(table, prop))
          .filter((column) => {
            const current = columns.get(column);
            return current !== undefined && current.precision < 6;
          });
        if (behind.length === 0) continue;
        const statement = `ALTER TABLE ${q(table)} ${behind
          .map(
            (column) =>
              `MODIFY COLUMN ${q(column)} ${MYSQL_DATETIME_TYPE} ${columns.get(column)?.nullable ? 'NULL' : 'NOT NULL'}`,
          )
          .join(', ')}`;
        const rows = await mysqlEstimatedRows(runner, table);
        if (rows > rowLimit) {
          deferred.push({ table, rows, statement });
          continue;
        }
        await runner.query(statement);
        repairs.push(
          `raised ${behind.map((column) => `${table}.${column}`).join(', ')} to ${MYSQL_DATETIME_TYPE}`,
        );
      }
    }
    // MySQL has no `CREATE INDEX IF NOT EXISTS`; create each best-effort and ignore "already exists".
    //  - status/wakeAt: the timer poller (listDueTimers) and recovery (listIncompleteRuns) scans.
    //  - workflow/status: the dashboard's listRuns filters. (Checkpoints are keyed by the PK prefix
    //    `(runId, seq)`, so listCheckpoints/getEvent already hit an index — no extra one needed.)
    const indexes: Array<[name: string, target: string, table: string]> = [
      [
        'durable_runs_status_idx',
        `${runs} (${runsCol('status')}, ${runsCol('wakeAt')})`,
        'durable_workflow_runs',
      ],
      [
        'durable_runs_workflow_status_idx',
        `${runs} (${runsCol('workflow')}, ${runsCol('status')})`,
        'durable_workflow_runs',
      ],
      // namespace/status/createdAt: every poll tick of a namespaced worker filters on `namespace`
      // ANDed with `status` (and `listPendingRuns` orders by `createdAt`), so without this the two
      // indexes above degrade to a scan of the WHOLE table — including every other tenant's rows —
      // on each tick. Created best-effort on every boot like the others, so a deployment whose table
      // already exists picks it up as soon as it runs this version.
      [
        'durable_runs_namespace_status_idx',
        `${runs} (${runsCol('namespace')}, ${runsCol('status')}, ${runsCol('createdAt')})`,
        'durable_workflow_runs',
      ],
      // A run's checkpoints by fan, in seq order: the run detail's per-group aggregates and fan
      // pages. `parallel_group` is `varchar(191)` in this DDL (also when added by ALTER above), so
      // MySQL can key it without a prefix length.
      [
        'durable_step_checkpoints_group_idx',
        `${checkpoints} (${cpCol('runId')}, ${cpCol('parallelGroup')}, ${cpCol('seq')})`,
        'durable_step_checkpoints',
      ],
      // A run's waiters: the `ctx.all` join barrier probes them once per settled child.
      [
        'durable_signal_waiters_run_id_idx',
        `${waiters} (${waiterCol('runId')})`,
        'durable_signal_waiters',
      ],
      // buffered signals are taken FIFO per token (smallest id) — index the token for the scan.
      [
        'durable_buffered_signals_token_idx',
        `${buffered} (${bufCol('token')})`,
        'durable_buffered_signals',
      ],
      // buffered events are scanned oldest-first per name — one composite index serves both.
      [
        'durable_buffered_events_name_published_at_idx',
        `${bufferedEvents} (${bevCol('name')}, ${bevCol('publishedAt')})`,
        'durable_buffered_events',
      ],
      // Search-attribute pushdown: equality + range predicates probe by (key, value). Two composite
      // indexes — one per typed column — so a numeric range or a string equality is an index scan.
      // Persisted schedules: the poll's "due by T" scan (`paused = false AND next_fire_at <= T`).
      [
        'durable_schedules_due_idx',
        `${schedules} (${schCol('paused')}, ${schCol('nextFireAt')})`,
        'durable_schedules',
      ],
      [
        'durable_run_attributes_num_idx',
        `${runAttributes} (${attrCol('key')}, ${attrCol('numValue')})`,
        'durable_run_attributes',
      ],
      [
        'durable_run_attributes_str_idx',
        `${runAttributes} (${attrCol('key')}, ${attrCol('strValue')})`,
        'durable_run_attributes',
      ],
    ];
    for (const [name, target, table] of indexes) {
      try {
        await runner.query(`CREATE INDEX ${q(name)} ON ${target}`);
        if (!created.has(table)) repairs.push(`created index ${name} on ${table}`);
      } catch {
        /* index already exists */
      }
    }
  } finally {
    await runner.release();
  }
  // A fresh install (no durable table existed before this boot) is the expected first run, not a
  // drift: stay quiet. Anything else that changed means the database was behind.
  const freshInstall = created.size === tables.length;
  if (repairs.length > 0 && !freshInstall) logger.warn(typeOrmSchemaRepairWarning(repairs));
  if (deferred.length > 0) logger.warn(typeOrmDeferredAlterWarning(deferred, rowLimit));
}

/** MySQL: the `datetime` columns of `table` with their fractional precision and nullability. */
async function mysqlDatetimeColumns(
  runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  table: string,
): Promise<Map<string, { precision: number; nullable: boolean }>> {
  const rows = (await runner.query(
    "SELECT column_name AS name, datetime_precision AS `precision`, is_nullable AS nullable FROM information_schema.columns WHERE table_name = ? AND TABLE_SCHEMA = DATABASE() AND data_type = 'datetime'",
    [table],
  )) as Array<{ name: string; precision: number | string | null; nullable: string }>;
  return new Map(
    rows.map((r) => [
      r.name,
      { precision: Number(r.precision ?? 0), nullable: String(r.nullable).toUpperCase() === 'YES' },
    ]),
  );
}

/** MySQL: InnoDB's row estimate for `table` (cheap: no scan). 0 when unknown. */
async function mysqlEstimatedRows(
  runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  table: string,
): Promise<number> {
  const rows = (await runner.query(
    'SELECT table_rows AS n FROM information_schema.tables WHERE table_name = ? AND TABLE_SCHEMA = DATABASE() LIMIT 1',
    [table],
  )) as Array<{ n: number | string | null }>;
  return Number(rows[0]?.n ?? 0);
}

/** The durable tables that exist before the boot-time check runs (to tell a created table apart). */
async function existingTables(
  runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  d: { isSqlite: boolean; isMysql: boolean },
): Promise<Set<string>> {
  const names = durableManagedTables();
  if (d.isSqlite) {
    const rows = (await runner.query(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )) as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name).filter((name) => names.includes(name)));
  }
  const scope = d.isMysql ? 'TABLE_SCHEMA = DATABASE()' : 'table_schema = current_schema()';
  const rows = (await runner.query(
    `SELECT table_name AS name FROM information_schema.tables WHERE ${scope}`,
  )) as Array<{ name?: string; TABLE_NAME?: string }>;
  return new Set(
    rows.map((r) => (r.name ?? r.TABLE_NAME) as string).filter((name) => names.includes(name)),
  );
}

/** MySQL: `column → data_type` for `table` (empty when the table does not exist). */
async function mysqlColumnTypes(
  runner: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  table: string,
): Promise<Map<string, string>> {
  const rows = (await runner.query(
    'SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = ? AND TABLE_SCHEMA = DATABASE()',
    [table],
  )) as Array<{ name?: string; type?: string; COLUMN_NAME?: string; DATA_TYPE?: string }>;
  return new Map(
    rows.map((r) => [
      (r.name ?? r.COLUMN_NAME) as string,
      String(r.type ?? r.DATA_TYPE).toLowerCase(),
    ]),
  );
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
