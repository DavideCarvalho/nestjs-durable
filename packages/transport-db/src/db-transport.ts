import { randomUUID } from 'node:crypto';
import {
  type Heartbeat,
  type RemoteTask,
  type RunConsumerOptions,
  type RunDispatch,
  type RunQueueOptions,
  type StepHandler,
  type StepResult,
  type Transport,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import type { SqlExecutor, SqlTx } from './executors';

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
interface RunRow {
  run_id: string;
}

/** A claimed run row: its run id and the token of this claim. */
interface ClaimedRun {
  runId: string;
  token: string;
}

/** Most rows one {@link DbTransport.dispatchRuns} insert writes. */
const RUNS_INSERT_CHUNK = 500;
/** Most run rows one consumer poll claims. */
const RUNS_CLAIM_MAX = 50;

/** A run-queue consumer started by {@link DbTransport.onDispatchedRun}. */
interface RunConsumer {
  stopped: boolean;
  /** Claim tokens of the rows whose runs are in flight. */
  inflight: Set<string>;
  slotFreed: (() => void) | undefined;
  loop: Promise<void>;
}

interface ResultRow {
  step_id: string;
  run_id: string;
  seq: string | number;
  status: string;
  output: string | null;
  error: string | null;
  started_at: string | number | null;
}

export interface DbTransportOptions {
  /**
   * How to run SQL — built from the app's **own** ORM/connection (no broker, no extra connection).
   * Use `mikroOrmExecutor(em)` to ride the app's MikroORM, `typeOrmExecutor(dataSource)` for TypeORM,
   * `drizzlePgExecutor(db)` (from `@dudousxd/nestjs-durable-store-drizzle/pg`) for Drizzle on
   * Postgres, or implement `SqlExecutor` for anything else.
   */
  executor: SqlExecutor;
  /** The worker group this instance serves. Required to register `handle()` consumers. */
  group?: string;
  /**
   * Table-name prefix. Tables: `${prefix}_transport_tasks` / `${prefix}_transport_results`, and
   * `${prefix}_transport_runs` for the run queue. Default `durable`.
   */
  prefix?: string;
  /** Poll interval in ms when a queue is empty. Default 500. */
  pollMs?: number;
  /**
   * How long a claimed row is owned before it's reclaimable (crash recovery), in ms. Default 30_000.
   * Every claim this instance holds is renewed every `leaseMs / 3` while it is waiting or running, so
   * a step may run longer than `leaseMs`; only a crashed (or event-loop-blocked) instance loses it.
   */
  leaseMs?: number;
  /**
   * Max rows claimed per poll. Default 10. The task loop claims only as many rows as it has free
   * {@link concurrency} slots (capped by this); the results loop claims up to this many.
   */
  batchSize?: number;
  /**
   * How many tasks this instance runs at once (worker side). Default 1. A row is claimed only when a
   * slot is free to run it, so rows never wait claimed behind a slow task while a sibling sits idle.
   */
  concurrency?: number;
  /**
   * Where a transport failure is reported: a failing poll, a throwing result handler (the result is
   * re-delivered after the lease), a lost claim. Default `console.error`.
   */
  onError?: (err: unknown) => void;
  /** Create the tables on first use if missing. Default true. */
  autoCreate?: boolean;
  /** Identifies this instance in `claimed_by` (for debugging). Defaults to a random id. */
  instanceId?: string;
}

/**
 * A numeric option: `fallback` unless `value` is a finite number of at least `min`. `Math.max(1, NaN)`
 * is `NaN`, so a clamp alone would let a `NaN` through (to `LIMIT NaN`, or a `NaN` timer).
 */
function numberOption(value: number | undefined, fallback: number, min: number): number {
  return value !== undefined && Number.isFinite(value) && value >= min ? value : fallback;
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
  private readonly group?: string | undefined;
  private readonly tasksTable: string;
  private readonly resultsTable: string;
  private readonly runsTable: string;
  private readonly runConsumers = new Set<RunConsumer>();
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly onError: (err: unknown) => void;
  private readonly autoCreate: boolean;
  private readonly instanceId: string;
  private readonly isPg: boolean;

  private readonly handlers = new Map<string, StepHandler>();
  private running = true;
  private schemaReady?: Promise<void> | undefined;
  private taskLoop?: Promise<void>;
  private resultLoop?: Promise<void>;
  /** Tasks running on this instance (at most `concurrency`). */
  private readonly runningTasks = new Set<Promise<void>>();
  /** Claim tokens this instance holds, by table — every one is renewed on `renewTimer`. */
  private readonly held = new Map<string, Set<string>>();
  private renewTimer?: ReturnType<typeof setInterval> | undefined;
  private renewal?: Promise<void> | undefined;

  constructor(options: DbTransportOptions) {
    this.exec = options.executor;
    this.group = options.group;
    const prefix = options.prefix ?? 'durable';
    this.tasksTable = `${prefix}_transport_tasks`;
    this.resultsTable = `${prefix}_transport_results`;
    this.runsTable = `${prefix}_transport_runs`;
    this.pollMs = numberOption(options.pollMs, 500, 0);
    this.leaseMs = numberOption(options.leaseMs, 30_000, 1);
    this.batchSize = Math.floor(numberOption(options.batchSize, 10, 1));
    this.concurrency = Math.floor(numberOption(options.concurrency, 1, 1));
    this.onError = options.onError ?? ((err) => console.error('[DbTransport]', err));
    this.autoCreate = options.autoCreate ?? true;
    // Random, not time-based: two instances booted in the same millisecond must not share an id.
    this.instanceId = options.instanceId ?? `db-${randomUUID()}`;
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
    if (!this.schemaReady) {
      // A failed attempt is not cached: the next call tries again instead of failing forever.
      this.schemaReady = this.createTables().catch((err) => {
        this.schemaReady = undefined;
        throw err;
      });
    }
    return this.schemaReady;
  }

  /**
   * Run one `CREATE … IF NOT EXISTS`. Two instances booting on a fresh database race it, and Postgres
   * can reject the loser with a unique violation on its catalog even with `IF NOT EXISTS`; the
   * statement is simply re-run, by which point the table exists and it is a no-op.
   */
  private async createIfMissing(sql: string): Promise<void> {
    try {
      await this.exec.query(sql);
    } catch {
      await this.exec.query(sql);
    }
  }

  private async createTables(): Promise<void> {
    if (!this.autoCreate) return;
    const str = 'varchar(191)';
    const txt = this.isPg ? 'text' : 'longtext';
    const tasks = this.q(this.tasksTable);
    const results = this.q(this.resultsTable);
    await this.createIfMissing(
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
    await this.createIfMissing(
      `CREATE TABLE IF NOT EXISTS ${results} (
        ${this.q('step_id')} ${str} PRIMARY KEY,
        ${this.q('run_id')} ${str} NOT NULL,
        ${this.q('seq')} integer NOT NULL,
        ${this.q('status')} varchar(32) NOT NULL,
        ${this.q('output')} ${txt},
        ${this.q('error')} ${txt},
        ${this.q('started_at')} bigint,
        ${this.q('claimed_by')} ${str},
        ${this.q('claimed_at')} bigint,
        ${this.q('created_at')} bigint NOT NULL
      )`,
    );
    await this.createIfMissing(
      `CREATE TABLE IF NOT EXISTS ${this.q(this.runsTable)} (
        ${this.q('run_id')} ${str} PRIMARY KEY,
        ${this.q('ns')} ${str} NOT NULL,
        ${this.q('priority')} integer NOT NULL,
        ${this.q('claimed_by')} ${str},
        ${this.q('claim_token')} ${str},
        ${this.q('claimed_at')} bigint,
        ${this.q('created_at')} bigint NOT NULL
      )`,
    );
    await this.exec
      .query(
        `CREATE INDEX ${this.q(`${this.runsTable}_ns_idx`)} ON ${this.q(this.runsTable)} (${this.q('ns')}, ${this.q('priority')}, ${this.q('created_at')})`,
      )
      .catch(() => {});
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
    const cols = [
      'step_id',
      'run_id',
      'seq',
      'name',
      'grp',
      'input',
      'attempt',
      'status',
      'created_at',
    ];
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

  // ── run queue (engine ↔ engine) ─────────────────────────────────────────────────────────────
  /**
   * Queue `pending` runs for whichever engine instance polls the run queue first: one row per run,
   * keyed by run id, so a run already waiting is not queued twice. A run whose row an instance holds
   * right now is released for another take, so a dispatch landing while the run's previous entry is
   * being handled is not lost when that entry is deleted. Up to {@link RUNS_INSERT_CHUNK} rows per
   * insert.
   */
  async dispatchRuns(runs: RunDispatch[], opts?: RunQueueOptions): Promise<void> {
    if (runs.length === 0) return;
    await this.ensureSchema();
    // One row per run: an upsert may not touch the same row twice in one statement.
    const unique = [...new Map(runs.map((run) => [run.runId, run])).values()];
    const t = this.q(this.runsTable);
    const cols = ['run_id', 'ns', 'priority', 'created_at'];
    const now = this.now();
    for (let at = 0; at < unique.length; at += RUNS_INSERT_CHUNK) {
      const chunk = unique.slice(at, at + RUNS_INSERT_CHUNK);
      const values = chunk
        .map((_, r) => `(${cols.map((__, c) => this.ph(r * cols.length + c + 1)).join(', ')})`)
        .join(', ');
      const insert = `INTO ${t} (${cols.map((c) => this.q(c)).join(', ')}) VALUES ${values}`;
      const release = ['claimed_by', 'claim_token', 'claimed_at']
        .map((c) => `${this.q(c)} = NULL`)
        .join(', ');
      const sql = this.isPg
        ? `INSERT ${insert} ON CONFLICT (${this.q('run_id')}) DO UPDATE SET ${release}`
        : `INSERT ${insert} ON DUPLICATE KEY UPDATE ${release}`;
      await this.exec.query(
        sql,
        chunk.flatMap((run, r) => [run.runId, opts?.namespace ?? '', run.priority ?? 0, now + r]),
      );
    }
  }

  /**
   * Poll the run queue, at most `opts.concurrency` runs in flight on this instance. Rows are claimed
   * with `FOR UPDATE SKIP LOCKED` (instances never take the same run), highest priority then oldest
   * first; a row is deleted once its handler settles, and its lease is renewed meanwhile, so a row is
   * re-taken only after the instance holding it went down. The returned stop takes no more rows and
   * resolves once the runs in flight settled.
   */
  onDispatchedRun(
    handler: (runId: string) => Promise<void>,
    opts: RunConsumerOptions,
  ): () => Promise<void> {
    const consumer: RunConsumer = {
      stopped: false,
      inflight: new Set(),
      slotFreed: undefined,
      loop: Promise.resolve(),
    };
    const concurrency = Math.max(1, Math.floor(opts.concurrency));
    const ns = opts.namespace ?? '';
    consumer.loop = this.consumeRuns(consumer, handler, concurrency, ns).catch((err) => {
      this.onError(err);
    });
    this.runConsumers.add(consumer);
    return () => this.stopRunConsumer(consumer);
  }

  private async stopRunConsumer(consumer: RunConsumer): Promise<void> {
    consumer.stopped = true;
    consumer.slotFreed?.();
    await consumer.loop;
    this.runConsumers.delete(consumer);
  }

  private async consumeRuns(
    consumer: RunConsumer,
    handler: (runId: string) => Promise<void>,
    concurrency: number,
    ns: string,
  ): Promise<void> {
    const renew = setInterval(
      () => void this.renewRunLeases(consumer).catch(() => undefined),
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    renew.unref?.();
    const settled = new Set<Promise<unknown>>();
    try {
      while (this.running && !consumer.stopped) {
        const free = concurrency - consumer.inflight.size;
        if (free <= 0) {
          await new Promise<void>((resolve) => {
            consumer.slotFreed = resolve;
          });
          consumer.slotFreed = undefined;
          continue;
        }
        let rows: ClaimedRun[] = [];
        try {
          await this.ensureSchema();
          rows = await this.claimRuns(ns, Math.min(free, RUNS_CLAIM_MAX));
        } catch (err) {
          if (this.running && !consumer.stopped) this.onError(err);
        }
        for (const { runId, token } of rows) {
          consumer.inflight.add(token);
          const done = handler(runId)
            .catch(() => undefined)
            .then(() =>
              this.exec
                .query(
                  `DELETE FROM ${this.q(this.runsTable)} WHERE ${this.q('claim_token')} = ${this.ph(1)}`,
                  [token],
                )
                .catch(() => undefined),
            )
            .finally(() => {
              consumer.inflight.delete(token);
              settled.delete(done);
              consumer.slotFreed?.();
            });
          settled.add(done);
        }
        if (rows.length === 0) await this.sleep(this.pollMs);
      }
      await Promise.allSettled([...settled]);
    } finally {
      clearInterval(renew);
    }
  }

  private async claimRuns(ns: string, limit: number): Promise<ClaimedRun[]> {
    const t = this.q(this.runsTable);
    const staleBefore = this.now() - this.leaseMs;
    return this.exec.transaction(async (tx) => {
      const rows = await tx.query<RunRow>(
        `SELECT ${this.q('run_id')} FROM ${t}
         WHERE ${this.q('ns')} = ${this.ph(1)}
           AND (${this.q('claimed_at')} IS NULL OR ${this.q('claimed_at')} < ${this.ph(2)})
         ORDER BY ${this.q('priority')} DESC, ${this.q('created_at')} ASC
         LIMIT ${Math.floor(limit)} FOR UPDATE SKIP LOCKED`,
        [ns, staleBefore],
      );
      const claimed = rows.map((r) => ({ runId: r.run_id, token: globalThis.crypto.randomUUID() }));
      const now = this.now();
      for (const { runId, token } of claimed) {
        await tx.query(
          `UPDATE ${t} SET ${this.q('claimed_by')} = ${this.ph(1)}, ${this.q('claim_token')} = ${this.ph(2)}, ${this.q('claimed_at')} = ${this.ph(3)}
           WHERE ${this.q('run_id')} = ${this.ph(4)}`,
          [this.instanceId, token, now, runId],
        );
      }
      return claimed;
    });
  }

  /** Keep the rows of the runs in flight leased, so a long turn is not re-taken by another instance. */
  private async renewRunLeases(consumer: RunConsumer): Promise<void> {
    const tokens = [...consumer.inflight];
    if (tokens.length === 0) return;
    await this.exec.query(
      `UPDATE ${this.q(this.runsTable)} SET ${this.q('claimed_at')} = ${this.ph(1)}
       WHERE ${this.q('claim_token')} IN (${tokens.map((_, i) => this.ph(i + 2)).join(', ')})`,
      [this.now(), ...tokens],
    );
  }

  // ── polling ──────────────────────────────────────────────────────────────────────────────────
  /** Run `tick` repeatedly; sleep `pollMs` when it reports an empty queue. Stops on `close()`. */
  private async loop(tick: () => Promise<number>): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        await this.ensureSchema();
        processed = await tick();
      } catch (err) {
        if (this.running) this.onError(err);
      }
      if (processed === 0 && this.running) await this.sleep(this.pollMs);
    }
  }

  /**
   * One task-loop round: claim as many rows as there are free slots (never more — a claimed row that
   * isn't running is one an idle sibling can't run), and start each. With every slot busy, wait for
   * one to free instead of polling.
   */
  private async drainTasks(group: string): Promise<number> {
    const free = this.concurrency - this.runningTasks.size;
    if (free <= 0) {
      await Promise.race(this.runningTasks);
      return 1;
    }
    const { rows, token } = await this.claim<TaskRow>(
      this.tasksTable,
      Math.min(free, this.batchSize),
      `${this.q('grp')} = ${this.ph(1)}`,
      [group],
    );
    if (rows.length === 0) return 0;
    this.hold(this.tasksTable, token);
    let left = rows.length;
    for (const row of rows) {
      const run = this.runTask(row, group, token).finally(() => {
        this.runningTasks.delete(run);
        left -= 1;
        if (left === 0) this.release(this.tasksTable, token);
      });
      this.runningTasks.add(run);
    }
    return rows.length;
  }

  /**
   * Run one claimed task and settle it — only while this instance still holds the claim: the claim is
   * re-checked before running, and the task row is deleted and its result written in ONE transaction,
   * conditional on the claim token, so an instance whose claim was taken over neither deletes the new
   * holder's row nor publishes a second result.
   */
  private async runTask(row: TaskRow, group: string, token: string): Promise<void> {
    try {
      if (!(await this.stillHolds(row.step_id, token))) {
        this.onError(
          new Error(
            `[DbTransport] lost the claim on task ${row.step_id} before running it — another instance took it over; not running it here`,
          ),
        );
        return;
      }
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
      if (!(await this.settleTask(task.stepId, token, result))) {
        this.onError(
          new Error(
            `[DbTransport] lost the claim on task ${task.stepId} while running it (this instance went silent past leaseMs) — another instance took it over and may run it too; this run's result was dropped. Raise leaseMs if steps block the event loop`,
          ),
        );
      }
    } catch (err) {
      // A database error settling the row (or a malformed row): it stays claimed, stops being
      // renewed, and is reclaimed after the lease — at-least-once, like a crash.
      this.onError(err);
    }
  }

  /** Whether the claim on `stepId` is still `token`'s (re-stamping it if so). */
  private async stillHolds(stepId: string, token: string): Promise<boolean> {
    const t = this.q(this.tasksTable);
    const rows = await this.exec.transaction(async (tx) => {
      const held = await tx.query<{ step_id: string }>(
        `SELECT ${this.q('step_id')} FROM ${t} WHERE ${this.q('step_id')} = ${this.ph(1)} AND ${this.q('claimed_by')} = ${this.ph(2)} FOR UPDATE`,
        [stepId, token],
      );
      if (held.length > 0) {
        await tx.query(
          `UPDATE ${t} SET ${this.q('claimed_at')} = ${this.ph(1)} WHERE ${this.q('step_id')} = ${this.ph(2)} AND ${this.q('claimed_by')} = ${this.ph(3)}`,
          [this.now(), stepId, token],
        );
      }
      return held;
    });
    return rows.length > 0;
  }

  /** Delete the task row and publish its result in ONE transaction, only while `token` holds it. */
  private async settleTask(stepId: string, token: string, result: StepResult): Promise<boolean> {
    const t = this.q(this.tasksTable);
    return this.exec.transaction(async (tx) => {
      const held = await tx.query<{ step_id: string }>(
        `SELECT ${this.q('step_id')} FROM ${t} WHERE ${this.q('step_id')} = ${this.ph(1)} AND ${this.q('claimed_by')} = ${this.ph(2)} FOR UPDATE`,
        [stepId, token],
      );
      if (held.length === 0) return false;
      await tx.query(
        `DELETE FROM ${t} WHERE ${this.q('step_id')} = ${this.ph(1)} AND ${this.q('claimed_by')} = ${this.ph(2)}`,
        [stepId, token],
      );
      await this.insertResult(result, tx);
      return true;
    });
  }

  /**
   * Claim a batch of results, deliver each to the engine, and delete it — only after its handler ran
   * (at-least-once), and only while this round still holds the claim (a newer result for the same
   * step that replaced the row resets the claim, so it is delivered next instead of deleted). The
   * batch's claim is renewed until it is done. A throwing handler is reported and its row left for
   * re-delivery after the lease; the rest of the batch continues.
   */
  private async drainResults(handler: (result: StepResult) => Promise<void>): Promise<number> {
    const { rows, token } = await this.claim<ResultRow>(
      this.resultsTable,
      this.batchSize,
      '1 = 1',
      [],
    );
    if (rows.length === 0) return 0;
    this.hold(this.resultsTable, token);
    try {
      for (const row of rows) {
        if (!this.running) break;
        try {
          const result: StepResult = {
            runId: row.run_id,
            seq: Number(row.seq),
            stepId: row.step_id,
            status: row.status as StepResult['status'],
            output: row.output == null ? undefined : JSON.parse(row.output),
            error: row.error == null ? undefined : JSON.parse(row.error),
            startedAt: row.started_at == null ? undefined : Number(row.started_at),
          };
          await handler(result);
          await this.exec.query(
            `DELETE FROM ${this.q(this.resultsTable)} WHERE ${this.q('step_id')} = ${this.ph(1)} AND ${this.q('claimed_by')} = ${this.ph(2)}`,
            [row.step_id, token],
          );
        } catch (err) {
          this.onError(err);
        }
      }
    } finally {
      this.release(this.resultsTable, token);
    }
    return rows.length;
  }

  /**
   * Atomically claim up to `limit` un-leased rows matching `where` and stamp them with a claim token
   * unique to this round (`<instanceId>:<uuid>`). `SELECT … FOR UPDATE SKIP LOCKED` inside the txn
   * means concurrent instances skip each other's locked rows instead of blocking, so no row is
   * claimed twice; the token is what every later delete/settle is conditional on.
   */
  private async claim<T extends { step_id: string }>(
    table: string,
    limit: number,
    where: string,
    whereParams: unknown[],
  ): Promise<{ rows: T[]; token: string }> {
    const t = this.q(table);
    const staleBefore = this.now() - this.leaseMs;
    const token = `${this.instanceId}:${randomUUID()}`;
    const rows = await this.exec.transaction(async (tx) => {
      const leaseClause = `(${this.q('claimed_at')} IS NULL OR ${this.q('claimed_at')} < ${this.ph(whereParams.length + 1)})`;
      const found = await tx.query<T>(
        `SELECT * FROM ${t} WHERE ${where} AND ${leaseClause}
         ORDER BY ${this.q('created_at')} ASC LIMIT ${Math.max(1, Math.floor(limit))} FOR UPDATE SKIP LOCKED`,
        [...whereParams, staleBefore],
      );
      if (found.length > 0) {
        const ids = found.map((r) => r.step_id);
        const placeholders = ids.map((_, i) => this.ph(i + 3)).join(', ');
        await tx.query(
          `UPDATE ${t} SET ${this.q('claimed_by')} = ${this.ph(1)}, ${this.q('claimed_at')} = ${this.ph(2)}
           WHERE ${this.q('step_id')} IN (${placeholders})`,
          [token, this.now(), ...ids],
        );
      }
      return found;
    });
    return { rows, token };
  }

  // ── claim renewal: every claim held, not only the row being run ─────────────────────────────
  private hold(table: string, token: string): void {
    let tokens = this.held.get(table);
    if (!tokens) {
      tokens = new Set();
      this.held.set(table, tokens);
    }
    tokens.add(token);
    if (this.renewTimer) return;
    const intervalMs = Math.max(10, Math.floor(this.leaseMs / 3));
    this.renewTimer = setInterval(() => {
      if (this.renewal) return; // a slow database never stacks renewal rounds
      const round = this.renewHeld()
        .catch((err) => this.onError(err))
        .finally(() => {
          if (this.renewal === round) this.renewal = undefined;
        });
      this.renewal = round;
    }, intervalMs);
    this.renewTimer.unref?.();
  }

  private release(table: string, token: string): void {
    const tokens = this.held.get(table);
    tokens?.delete(token);
    if (tokens?.size === 0) this.held.delete(table);
    if (this.held.size === 0 && this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  /** Re-stamp `claimed_at` on every row still claimed under a token this instance holds. */
  private async renewHeld(): Promise<void> {
    for (const [table, tokens] of this.held) {
      if (tokens.size === 0) continue;
      const list = [...tokens];
      const placeholders = list.map((_, i) => this.ph(i + 2)).join(', ');
      await this.exec.query(
        `UPDATE ${this.q(table)} SET ${this.q('claimed_at')} = ${this.ph(1)} WHERE ${this.q('claimed_by')} IN (${placeholders})`,
        [this.now(), ...list],
      );
    }
  }

  /**
   * Write a result row. A result already waiting for the same step (an earlier attempt's, not yet
   * deleted by the engine) is REPLACED and its claim reset, never kept: `step_id` is stable across
   * attempts, so keeping the old row would silently drop a retry's result.
   */
  private async insertResult(result: StepResult, tx: SqlTx = this.exec): Promise<void> {
    const t = this.q(this.resultsTable);
    const cols = [
      'step_id',
      'run_id',
      'seq',
      'status',
      'output',
      'error',
      'started_at',
      'created_at',
    ];
    const replace = ['run_id', 'seq', 'status', 'output', 'error', 'started_at', 'created_at'];
    const values = `(${cols.map((c) => this.q(c)).join(', ')}) VALUES (${cols.map((_, i) => this.ph(i + 1)).join(', ')})`;
    const sql = this.isPg
      ? `INSERT INTO ${t} ${values} ON CONFLICT (${this.q('step_id')}) DO UPDATE SET ${[
          ...replace.map((c) => `${this.q(c)} = EXCLUDED.${this.q(c)}`),
          `${this.q('claimed_by')} = NULL`,
          `${this.q('claimed_at')} = NULL`,
        ].join(', ')}`
      : `INSERT INTO ${t} ${values} ON DUPLICATE KEY UPDATE ${[
          ...replace.map((c) => `${this.q(c)} = VALUES(${this.q(c)})`),
          `${this.q('claimed_by')} = NULL`,
          `${this.q('claimed_at')} = NULL`,
        ].join(', ')}`;
    await tx.query(sql, [
      result.stepId,
      result.runId,
      result.seq,
      result.status,
      result.output === undefined ? null : JSON.stringify(result.output),
      result.error === undefined ? null : JSON.stringify(result.error),
      result.startedAt ?? null,
      this.now(),
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Stop the pollers and wait for the current ticks to settle. Does not close the shared DataSource. */
  async close(): Promise<void> {
    this.running = false;
    await Promise.allSettled([
      this.taskLoop,
      this.resultLoop,
      ...[...this.runConsumers].map((c) => this.stopRunConsumer(c)),
    ]);
    // Let running tasks settle (their claims keep being renewed until they do).
    await Promise.allSettled([...this.runningTasks]);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = undefined;
    await this.renewal;
  }
}
