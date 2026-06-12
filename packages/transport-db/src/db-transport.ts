import {
  type Heartbeat,
  type RemoteTask,
  type StepHandler,
  type StepResult,
  type Transport,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import type { SqlExecutor } from './executors';

export { mikroOrmExecutor, type SqlExecutor, type SqlTx, typeOrmExecutor } from './executors';

/** Raw row shapes returned by `SELECT *` (declared fields, so they're not `| undefined` under noUncheckedIndexedAccess). */
interface TaskRow {
  step_id: string;
  run_id: string;
  seq: string | number;
  name: string;
  input: string | null;
  attempt: string | number;
}
interface ResultRow {
  step_id: string;
  run_id: string;
  seq: string | number;
  status: string;
  output: string | null;
  error: string | null;
}

export interface DbTransportOptions {
  /**
   * How to run SQL — built from the app's **own** ORM/connection (no broker, no extra connection).
   * Use `mikroOrmExecutor(em)` to ride the app's MikroORM, `typeOrmExecutor(dataSource)` for TypeORM,
   * or implement `SqlExecutor` for anything else.
   */
  executor: SqlExecutor;
  /** The worker group this instance serves. Required to register `handle()` consumers. */
  group?: string;
  /** Table-name prefix. Tables: `${prefix}_transport_tasks` / `${prefix}_transport_results`. Default `durable`. */
  prefix?: string;
  /** Poll interval in ms when a queue is empty. Default 500. */
  pollMs?: number;
  /** How long a claimed row is owned before it's reclaimable (crash recovery), in ms. Default 30_000. */
  leaseMs?: number;
  /** Max rows claimed per poll. Default 10. */
  batchSize?: number;
  /** Create the two tables on first use if missing. Default true. */
  autoCreate?: boolean;
  /** Identifies this instance in `claimed_by` (for debugging). Defaults to a random id. */
  instanceId?: string;
}

/**
 * A SQL-backed `Transport` — DBOS-style. Instead of a broker (Redis/SQS), remote steps are **rows**
 * in the same database the durable store already uses: `dispatch` inserts a task row, a worker
 * claims it with `SELECT … FOR UPDATE SKIP LOCKED` (so instances never double-claim), runs it, and
 * writes a result row the engine polls. Zero new infrastructure — the DB you already have IS the
 * queue.
 *
 * Trade-off vs a real broker: throughput is bounded by polling + row contention. Great for
 * workflow/pipeline scale (modest rate, long steps); not for high-fanout firehoses.
 *
 * Requires `FOR UPDATE SKIP LOCKED` — **MySQL 8+** or **Postgres 9.5+** (not SQLite). Run one
 * instance engine-side (`onResult`, dispatches) and one per worker process (`handle()` for its group).
 */
export class DbTransport implements Transport {
  private readonly exec: SqlExecutor;
  private readonly group?: string;
  private readonly tasksTable: string;
  private readonly resultsTable: string;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly autoCreate: boolean;
  private readonly instanceId: string;
  private readonly isPg: boolean;

  private readonly handlers = new Map<string, StepHandler>();
  private running = true;
  private schemaReady?: Promise<void>;
  private taskLoop?: Promise<void>;
  private resultLoop?: Promise<void>;

  constructor(options: DbTransportOptions) {
    this.exec = options.executor;
    this.group = options.group;
    const prefix = options.prefix ?? 'durable';
    this.tasksTable = `${prefix}_transport_tasks`;
    this.resultsTable = `${prefix}_transport_results`;
    this.pollMs = options.pollMs ?? 500;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.batchSize = options.batchSize ?? 10;
    this.autoCreate = options.autoCreate ?? true;
    this.instanceId = options.instanceId ?? `db-${Math.floor(Date.now()).toString(36)}`;
    this.isPg = this.exec.dialect === 'postgres';
  }

  // ── dialect helpers ──────────────────────────────────────────────────────────────────────────
  /** Positional placeholder for param `i` (1-based): `$i` on Postgres, `?` elsewhere. */
  private ph(i: number): string {
    return this.isPg ? `$${i}` : '?';
  }
  private q(id: string): string {
    return this.exec.escapeId(id);
  }
  private now(): number {
    return Math.floor(Date.now());
  }

  // ── schema ───────────────────────────────────────────────────────────────────────────────────
  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) this.schemaReady = this.createTables();
    return this.schemaReady;
  }

  private async createTables(): Promise<void> {
    if (!this.autoCreate) return;
    const str = 'varchar(191)';
    const txt = this.isPg ? 'text' : 'longtext';
    const tasks = this.q(this.tasksTable);
    const results = this.q(this.resultsTable);
    await this.exec.query(
      `CREATE TABLE IF NOT EXISTS ${tasks} (
        ${this.q('step_id')} ${str} PRIMARY KEY,
        ${this.q('run_id')} ${str} NOT NULL,
        ${this.q('seq')} integer NOT NULL,
        ${this.q('name')} ${str} NOT NULL,
        ${this.q('grp')} ${str} NOT NULL,
        ${this.q('input')} ${txt},
        ${this.q('attempt')} integer NOT NULL,
        ${this.q('status')} varchar(32) NOT NULL,
        ${this.q('claimed_by')} ${str},
        ${this.q('claimed_at')} bigint,
        ${this.q('created_at')} bigint NOT NULL
      )`,
    );
    await this.exec.query(
      `CREATE TABLE IF NOT EXISTS ${results} (
        ${this.q('step_id')} ${str} PRIMARY KEY,
        ${this.q('run_id')} ${str} NOT NULL,
        ${this.q('seq')} integer NOT NULL,
        ${this.q('status')} varchar(32) NOT NULL,
        ${this.q('output')} ${txt},
        ${this.q('error')} ${txt},
        ${this.q('claimed_by')} ${str},
        ${this.q('claimed_at')} bigint,
        ${this.q('created_at')} bigint NOT NULL
      )`,
    );
    // Best-effort index for the group poll (MySQL has no CREATE INDEX IF NOT EXISTS < 8.0.13).
    await this.exec
      .query(
        `CREATE INDEX ${this.q(`${this.tasksTable}_grp_idx`)} ON ${tasks} (${this.q('grp')}, ${this.q('status')}, ${this.q('created_at')})`,
      )
      .catch(() => {});
  }

  // ── engine → worker ────────────────────────────────────────────────────────────────────────
  async dispatch(task: RemoteTask): Promise<void> {
    await this.ensureSchema();
    const t = this.q(this.tasksTable);
    // Idempotent: a redelivered dispatch for the same step_id is ignored (the row already exists).
    const ignore = this.isPg
      ? `INSERT INTO ${t} (...) ON CONFLICT (${this.q('step_id')}) DO NOTHING`
      : `INSERT IGNORE INTO ${t} (...)`;
    const cols = ['step_id', 'run_id', 'seq', 'name', 'grp', 'input', 'attempt', 'status', 'created_at'];
    const sql = ignore.replace(
      '(...)',
      `(${cols.map((c) => this.q(c)).join(', ')}) VALUES (${cols.map((_, i) => this.ph(i + 1)).join(', ')})`,
    );
    await this.exec.query(sql, [
      task.stepId,
      task.runId,
      task.seq,
      task.name,
      task.group,
      JSON.stringify(task.input ?? null),
      task.attempt,
      'pending',
      this.now(),
    ]);
  }

  // ── worker → engine ────────────────────────────────────────────────────────────────────────
  handle(name: string, fn: StepHandler): void {
    if (!this.group) throw new Error('DbTransport needs a `group` to register handlers');
    this.handlers.set(name, fn);
    if (!this.taskLoop) this.taskLoop = this.loop(() => this.drainTasks(this.group as string));
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    if (!this.resultLoop) this.resultLoop = this.loop(() => this.drainResults(handler));
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {
    // Not modelled; the lease/reclaim on `claimed_at` is the liveness mechanism.
  }

  // ── polling ──────────────────────────────────────────────────────────────────────────────────
  /** Run `tick` repeatedly; sleep `pollMs` when it reports an empty queue. Stops on `close()`. */
  private async loop(tick: () => Promise<number>): Promise<void> {
    await this.ensureSchema();
    while (this.running) {
      let processed = 0;
      try {
        processed = await tick();
      } catch (err) {
        if (this.running) console.error('[DbTransport] poll failed', err);
      }
      if (processed === 0) await this.sleep(this.pollMs);
    }
  }

  /** Claim a batch of tasks (FOR UPDATE SKIP LOCKED), then run each outside the lock. */
  private async drainTasks(group: string): Promise<number> {
    const claimed = await this.claim<TaskRow>(
      this.tasksTable,
      `${this.q('grp')} = ${this.ph(1)}`,
      [group],
    );
    for (const row of claimed) {
      const task: RemoteTask = {
        runId: row.run_id,
        seq: Number(row.seq),
        stepId: row.step_id,
        name: row.name,
        group,
        input: row.input == null ? undefined : JSON.parse(row.input),
        attempt: Number(row.attempt),
      };
      const result = await runStepHandler(task, this.handlers.get(task.name));
      await this.insertResult(result);
      await this.exec.query(
        `DELETE FROM ${this.q(this.tasksTable)} WHERE ${this.q('step_id')} = ${this.ph(1)}`,
        [task.stepId],
      );
    }
    return claimed.length;
  }

  /** Claim a batch of results, deliver each to the engine, then delete it. */
  private async drainResults(handler: (result: StepResult) => Promise<void>): Promise<number> {
    const claimed = await this.claim<ResultRow>(this.resultsTable, '1 = 1', []);
    for (const row of claimed) {
      const result: StepResult = {
        runId: row.run_id,
        seq: Number(row.seq),
        stepId: row.step_id,
        status: row.status as StepResult['status'],
        output: row.output == null ? undefined : JSON.parse(row.output),
        error: row.error == null ? undefined : JSON.parse(row.error),
      };
      await handler(result);
      await this.exec.query(
        `DELETE FROM ${this.q(this.resultsTable)} WHERE ${this.q('step_id')} = ${this.ph(1)}`,
        [result.stepId],
      );
    }
    return claimed.length;
  }

  /**
   * Atomically claim up to `batchSize` un-leased rows matching `where` and stamp them with this
   * instance's lease. `SELECT … FOR UPDATE SKIP LOCKED` inside the txn means concurrent instances
   * skip each other's locked rows instead of blocking, so no row is claimed twice.
   */
  private async claim<T extends { step_id: string }>(
    table: string,
    where: string,
    whereParams: unknown[],
  ): Promise<T[]> {
    const t = this.q(table);
    const staleBefore = this.now() - this.leaseMs;
    return this.exec.transaction(async (tx) => {
      const leaseClause = `(${this.q('claimed_at')} IS NULL OR ${this.q('claimed_at')} < ${this.ph(whereParams.length + 1)})`;
      const rows = await tx.query<T>(
        `SELECT * FROM ${t} WHERE ${where} AND ${leaseClause}
         ORDER BY ${this.q('created_at')} ASC LIMIT ${this.batchSize} FOR UPDATE SKIP LOCKED`,
        [...whereParams, staleBefore],
      );
      if (rows.length > 0) {
        const ids = rows.map((r) => r.step_id);
        const placeholders = ids.map((_, i) => this.ph(i + 3)).join(', ');
        await tx.query(
          `UPDATE ${t} SET ${this.q('claimed_by')} = ${this.ph(1)}, ${this.q('claimed_at')} = ${this.ph(2)}
           WHERE ${this.q('step_id')} IN (${placeholders})`,
          [this.instanceId, this.now(), ...ids],
        );
      }
      return rows;
    });
  }

  private async insertResult(result: StepResult): Promise<void> {
    const t = this.q(this.resultsTable);
    const cols = ['step_id', 'run_id', 'seq', 'status', 'output', 'error', 'created_at'];
    const head = this.isPg
      ? `INSERT INTO ${t} (...) ON CONFLICT (${this.q('step_id')}) DO NOTHING`
      : `INSERT IGNORE INTO ${t} (...)`;
    const sql = head.replace(
      '(...)',
      `(${cols.map((c) => this.q(c)).join(', ')}) VALUES (${cols.map((_, i) => this.ph(i + 1)).join(', ')})`,
    );
    await this.exec.query(sql, [
      result.stepId,
      result.runId,
      result.seq,
      result.status,
      result.output === undefined ? null : JSON.stringify(result.output),
      result.error === undefined ? null : JSON.stringify(result.error),
      this.now(),
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Stop the pollers and wait for the current ticks to settle. Does not close the shared DataSource. */
  async close(): Promise<void> {
    this.running = false;
    await Promise.allSettled([this.taskLoop, this.resultLoop]);
  }
}
