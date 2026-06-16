import type { DataSource } from 'typeorm';

/** The JSON-blob columns per table (keyed by table name) that hold free-form payloads and so must
 *  be the unbounded text type — `longtext` on MySQL, `text` elsewhere. */
export const JSON_BLOB_COLUMNS: Record<string, string[]> = {
  durable_workflow_runs: ['input', 'output', 'error', 'tags', 'searchAttributes'],
  durable_step_checkpoints: ['input', 'output', 'error', 'events'],
};

/** The SQL type for free-form JSON-blob columns. MySQL `text` caps at 64KB and silently truncates,
 *  so use `longtext` (4GB) there; Postgres/SQLite `text` is already unbounded. */
export function jsonBlobColumnType(isMysql: boolean): 'longtext' | 'text' {
  return isMysql ? 'longtext' : 'text';
}

/** Idempotent `MODIFY COLUMN ... longtext` statements that widen pre-existing MySQL `text` JSON-blob
 *  columns. Returns `[]` on non-MySQL dialects (their `text` is already unbounded — nothing to do).
 *  `quote` quotes an identifier per the active driver. */
export function buildWidenStatements(isMysql: boolean, quote: (id: string) => string): string[] {
  if (!isMysql) return [];
  const out: string[] = [];
  for (const [table, cols] of Object.entries(JSON_BLOB_COLUMNS)) {
    for (const col of cols) {
      out.push(`ALTER TABLE ${quote(table)} MODIFY COLUMN ${quote(col)} longtext`);
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

  const runs = q('durable_workflow_runs');
  const checkpoints = q('durable_step_checkpoints');
  const waiters = q('durable_signal_waiters');
  const buffered = q('durable_buffered_signals');

  // Auto-increment PK syntax differs per dialect: SQLite wants `INTEGER PRIMARY KEY AUTOINCREMENT`,
  // MySQL `BIGINT AUTO_INCREMENT PRIMARY KEY`, Postgres `BIGSERIAL PRIMARY KEY`.
  const bufferedId = isSqlite
    ? `${q('id')} integer PRIMARY KEY AUTOINCREMENT`
    : isMysql
      ? `${q('id')} bigint NOT NULL AUTO_INCREMENT PRIMARY KEY`
      : isPg
        ? `${q('id')} bigserial PRIMARY KEY`
        : `${q('id')} bigint NOT NULL AUTO_INCREMENT PRIMARY KEY`;

  const tables = [
    `CREATE TABLE IF NOT EXISTS ${runs} (
      ${q('id')} ${str} PRIMARY KEY,
      ${q('workflow')} ${str} NOT NULL,
      ${q('workflowVersion')} ${str} NOT NULL,
      ${q('status')} ${str} NOT NULL,
      ${q('input')} ${txt}, ${q('output')} ${txt}, ${q('error')} ${txt},
      ${q('wakeAt')} ${ts}, ${q('lockedBy')} ${str}, ${q('lockedUntil')} ${ts},
      ${q('recoveryAttempts')} ${int}, ${q('tags')} ${txt}, ${q('searchAttributes')} ${txt},
      ${q('createdAt')} ${ts} NOT NULL, ${q('updatedAt')} ${ts} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${checkpoints} (
      ${q('runId')} ${str} NOT NULL, ${q('seq')} ${int} NOT NULL,
      ${q('name')} ${str} NOT NULL, ${q('kind')} ${str} NOT NULL, ${q('stepId')} ${str} NOT NULL,
      ${q('status')} ${str} NOT NULL, ${q('input')} ${txt}, ${q('output')} ${txt}, ${q('error')} ${txt}, ${q('events')} ${txt},
      ${q('attempts')} ${int} NOT NULL, ${q('workerGroup')} ${str},
      ${q('wakeAt')} ${ts}, ${q('enqueuedAt')} ${ts},
      ${q('startedAt')} ${ts} NOT NULL, ${q('finishedAt')} ${ts} NOT NULL,
      PRIMARY KEY (${q('runId')}, ${q('seq')})
    )`,
    `CREATE TABLE IF NOT EXISTS ${waiters} (
      ${q('token')} ${str} PRIMARY KEY, ${q('runId')} ${str} NOT NULL, ${q('seq')} ${int} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${buffered} (
      ${bufferedId}, ${q('token')} ${str} NOT NULL, ${q('payload')} ${txt}
    )`,
  ];

  // Additive nullable columns gained across versions (e.g. `input`, `events`, `enqueuedAt`). On a
  // table that predates them, `CREATE TABLE IF NOT EXISTS` above is a no-op, so back-fill the ones
  // that are actually missing — the auto-schema self-heals instead of needing a manual migration.
  // We check the live columns first (rather than ALTER-and-ignore) so a *real* ALTER failure
  // surfaces instead of being swallowed as a presumed "column already exists".
  const additive: Record<string, Array<[string, string]>> = {
    durable_workflow_runs: [
      ['input', txt],
      ['output', txt],
      ['error', txt],
      ['recoveryAttempts', int],
      ['tags', txt],
      ['searchAttributes', txt],
    ],
    durable_step_checkpoints: [
      ['input', txt],
      ['output', txt],
      ['error', txt],
      ['events', txt],
      ['workerGroup', str],
      ['enqueuedAt', ts],
    ],
  };

  const runner = dataSource.createQueryRunner();
  try {
    for (const sql of tables) await runner.query(sql);
    for (const [table, cols] of Object.entries(additive)) {
      const have = await existingColumns(runner, table, { isSqlite, isMysql });
      for (const [col, colType] of cols) {
        if (!have.has(col)) {
          await runner.query(`ALTER TABLE ${q(table)} ADD COLUMN ${q(col)} ${colType}`);
        }
      }
    }
    // Widen pre-existing MySQL `text` JSON-blob columns to `longtext`. A table created before this
    // fix has these as `text` (64KB) and silently truncates large `events`/`output` payloads. MODIFY
    // to `longtext` is idempotent (no-op if already longtext), so it's safe to run on every boot.
    // MySQL-only: Postgres/SQLite `text` is already unbounded, so there's nothing to widen.
    for (const sql of buildWidenStatements(isMysql, q)) {
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
      ['durable_runs_status_idx', `${runs} (${q('status')}, ${q('wakeAt')})`],
      ['durable_runs_workflow_status_idx', `${runs} (${q('workflow')}, ${q('status')})`],
      // buffered signals are taken FIFO per token (smallest id) — index the token for the scan.
      ['durable_buffered_signals_token_idx', `${buffered} (${q('token')})`],
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
  const scope = d.isMysql ? 'TABLE_SCHEMA = DATABASE()' : 'table_schema = current_schema()';
  const rows = (await runner.query(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? AND ${scope}`,
    [table],
  )) as Array<{ name?: string; COLUMN_NAME?: string }>;
  return new Set(rows.map((r) => (r.name ?? r.COLUMN_NAME) as string));
}
