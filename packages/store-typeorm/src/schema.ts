import type { DataSource } from 'typeorm';

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

  // Keyed/short strings must be varchar on MySQL (a `text` PK/index needs a key length); `text`
  // for the free-form JSON payloads. Dates use the dialect's native timestamp type.
  const str = 'varchar(191)';
  const txt = 'text';
  const int = isMysql ? 'int' : 'integer';
  const ts = isPg ? 'timestamptz' : 'datetime';

  const runs = q('durable_workflow_runs');
  const checkpoints = q('durable_step_checkpoints');
  const waiters = q('durable_signal_waiters');

  const tables = [
    `CREATE TABLE IF NOT EXISTS ${runs} (
      ${q('id')} ${str} PRIMARY KEY,
      ${q('workflow')} ${str} NOT NULL,
      ${q('workflowVersion')} ${str} NOT NULL,
      ${q('status')} ${str} NOT NULL,
      ${q('input')} ${txt}, ${q('output')} ${txt}, ${q('error')} ${txt},
      ${q('wakeAt')} ${ts}, ${q('lockedBy')} ${str}, ${q('lockedUntil')} ${ts},
      ${q('createdAt')} ${ts} NOT NULL, ${q('updatedAt')} ${ts} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${checkpoints} (
      ${q('runId')} ${str} NOT NULL, ${q('seq')} ${int} NOT NULL,
      ${q('name')} ${str} NOT NULL, ${q('kind')} ${str} NOT NULL, ${q('stepId')} ${str} NOT NULL,
      ${q('status')} ${str} NOT NULL, ${q('output')} ${txt}, ${q('error')} ${txt},
      ${q('attempts')} ${int} NOT NULL, ${q('workerGroup')} ${str},
      ${q('wakeAt')} ${ts}, ${q('startedAt')} ${ts} NOT NULL, ${q('finishedAt')} ${ts} NOT NULL,
      PRIMARY KEY (${q('runId')}, ${q('seq')})
    )`,
    `CREATE TABLE IF NOT EXISTS ${waiters} (
      ${q('token')} ${str} PRIMARY KEY, ${q('runId')} ${str} NOT NULL, ${q('seq')} ${int} NOT NULL
    )`,
  ];

  const runner = dataSource.createQueryRunner();
  try {
    for (const sql of tables) await runner.query(sql);
    // MySQL has no `CREATE INDEX IF NOT EXISTS`; create it best-effort and ignore "already exists".
    try {
      await runner.query(
        `CREATE INDEX ${q('durable_runs_status_idx')} ON ${runs} (${q('status')}, ${q('wakeAt')})`,
      );
    } catch {
      /* index already exists */
    }
  } finally {
    await runner.release();
  }
}
