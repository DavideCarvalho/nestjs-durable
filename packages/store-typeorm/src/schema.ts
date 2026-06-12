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
 * Only ever adds the three durable tables — it never touches your other tables.
 */
export async function ensureTypeOrmDurableSchema(dataSource: DataSource): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS durable_workflow_runs (
      id text PRIMARY KEY,
      workflow text NOT NULL,
      "workflowVersion" text NOT NULL,
      status text NOT NULL,
      input text,
      output text,
      error text,
      "wakeAt" datetime,
      "createdAt" datetime NOT NULL,
      "updatedAt" datetime NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS durable_step_checkpoints (
      "runId" text NOT NULL,
      seq integer NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      "stepId" text NOT NULL,
      status text NOT NULL,
      output text,
      error text,
      attempts integer NOT NULL,
      "workerGroup" text,
      "wakeAt" datetime,
      "startedAt" datetime NOT NULL,
      "finishedAt" datetime NOT NULL,
      PRIMARY KEY ("runId", seq)
    )`,
    `CREATE TABLE IF NOT EXISTS durable_signal_waiters (
      token text PRIMARY KEY,
      "runId" text NOT NULL,
      seq integer NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS durable_runs_status_idx ON durable_workflow_runs (status, "wakeAt")`,
  ];
  const runner = dataSource.createQueryRunner();
  try {
    for (const sql of statements) {
      await runner.query(sql);
    }
  } finally {
    await runner.release();
  }
}
