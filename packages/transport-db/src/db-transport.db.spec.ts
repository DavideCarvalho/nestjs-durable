import 'reflect-metadata';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbTransport } from './db-transport';
import { typeOrmExecutor } from './executors';

/**
 * Real-engine matrix for the SQL transport: a Postgres container spun up via testcontainers, so the
 * DBOS-style row-as-queue round-trip — which needs real `FOR UPDATE SKIP LOCKED` (unavailable on
 * SQLite) — and the failed-result path run against an actual engine instead of self-skipping. Run
 * with `pnpm test:db`.
 *
 * Postgres (not MySQL) to reuse the stores' container image; the transport's DDL + claim SQL are
 * dialect-aware (the executor reports `postgres`, so quoting is double-quotes and placeholders are
 * `$n`). Skips cleanly when Docker is unavailable or `SKIP_TESTCONTAINERS` is set.
 */

const CONTAINER_TIMEOUT = 180_000;
// An existing Postgres to run against instead of a testcontainer (as the store-drizzle suite does).
const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;

let pg: StartedPostgreSqlContainer | undefined;
let pgError: unknown;
let ds: DataSource | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    if (externalUrl) {
      ds = new DataSource({ type: 'postgres', url: externalUrl });
      await ds.initialize();
      return;
    }
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
    });
    await ds.initialize();
  } catch (err) {
    pgError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  await pg?.stop();
});

const CHARGE_CARD_STEP_NAME = 'payments.charge-card';

// DbTransport isn't routed by handler name — `dispatch()` writes the engine's already-computed
// routing token (`tenantGroup(sanitizeQueueToken(step.name), step.partition)`, bare-name here since
// `ctx.step` never sets a `partition`) straight into the `grp` column, and `handle()` polls WHERE
// grp = this `group` verbatim. So the transport's `group` must equal the step's bare sanitized name
// for dispatch and consume to land on the same rows.
const workerGroup = 'payments.charge-card';

/** A durable ctx.call suspends; poll the store until the DB round-trip resumes it to a terminal state. */
async function settle(store: InMemoryStateStore, runId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended')
      return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

async function dropTables(prefix: string) {
  if (!ds) return;
  await ds.query(`DROP TABLE IF EXISTS "${prefix}_transport_tasks"`);
  await ds.query(`DROP TABLE IF EXISTS "${prefix}_transport_results"`);
}

/** Resolve the live DataSource or self-skip the case when Docker isn't available. */
function liveDataSource(ctx: { skip: () => void }): DataSource {
  if (skipped || pgError || !ds?.isInitialized) {
    ctx.skip();
    throw new Error('unreachable'); // ctx.skip() aborts; keeps the type non-undefined
  }
  return ds;
}

describe('DbTransport (real Postgres) [testcontainers]', () => {
  it('dispatches a remote step through the DB and returns the checkpointed result', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durtest${Date.now()}`;
    const transport = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: workerGroup,
      prefix,
      pollMs: 50,
    });
    transport.handle(CHARGE_CARD_STEP_NAME, async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.step<{ chargeId: string }>(CHARGE_CARD_STEP_NAME, { amount: 7 });
      return charge.chargeId;
    });

    await engine.start('checkout', {}, `run-${prefix}`);
    const result = await settle(store, `run-${prefix}`);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_7');

    await transport.close();
    await dropTables(prefix);
  }, 30_000);

  it('reports a failed result when the worker handler throws', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durtestf${Date.now()}`;
    const transport = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: workerGroup,
      prefix,
      pollMs: 50,
    });
    transport.handle(CHARGE_CARD_STEP_NAME, async () => {
      throw new Error('declined');
    });

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => c.step(CHARGE_CARD_STEP_NAME, { amount: 1 }));

    await engine.start('checkout', {}, `run-${prefix}`);
    const result = await settle(store, `run-${prefix}`);
    expect(result.status).toBe('failed');

    await transport.close();
    await dropTables(prefix);
  }, 30_000);

  // ── claim safety ──────────────────────────────────────────────────────────────────────────────
  // Each case drives the transport directly (no engine): tasks are `dispatch`ed rows, and the
  // handler records which instance ran which step, so a double run is visible as a duplicate.

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const remoteTask = (stepId: string) => ({
    runId: `run-${stepId}`,
    seq: 0,
    stepId,
    name: CHARGE_CARD_STEP_NAME,
    group: workerGroup,
    input: { stepId },
    attempt: 1,
  });

  it('never runs a task twice when it outlives leaseMs (the running claim is renewed)', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durlease${Date.now()}`;
    const runs: string[] = [];
    const make = (id: string) => {
      const t = new DbTransport({
        executor: typeOrmExecutor(ds),
        group: workerGroup,
        prefix,
        pollMs: 20,
        leaseMs: 300,
        instanceId: id,
      });
      t.handle(CHARGE_CARD_STEP_NAME, async (input: { stepId: string }) => {
        runs.push(`${input.stepId}@${id}`);
        await sleep(1_200);
        return 'ok';
      });
      return t;
    };
    const a = make('a');
    await a.dispatch(remoteTask('s1'));
    await sleep(150); // a claims s1
    const b = make('b');
    await sleep(1_600);
    await Promise.all([a.close(), b.close()]);
    expect(runs).toEqual(['s1@a']);
    await dropTables(prefix);
  }, 30_000);

  it('claims only what it can run: rows waiting behind a slow task go to an idle sibling', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durbatch${Date.now()}`;
    const runs: string[] = [];
    const make = (id: string) => {
      const t = new DbTransport({
        executor: typeOrmExecutor(ds),
        group: workerGroup,
        prefix,
        pollMs: 20,
        leaseMs: 300,
        instanceId: id,
      });
      t.handle(CHARGE_CARD_STEP_NAME, async (input: { stepId: string }) => {
        runs.push(input.stepId);
        await sleep(500);
        return 'ok';
      });
      return t;
    };
    const seed = make('seed');
    await seed.close();
    for (const id of ['s1', 's2', 's3']) await seed.dispatch(remoteTask(id));
    const a = make('a');
    const b = make('b');
    await sleep(3_000);
    await Promise.all([a.close(), b.close()]);
    // Every task ran exactly once, none twice.
    expect([...runs].sort()).toEqual(['s1', 's2', 's3']);
    await dropTables(prefix);
  }, 30_000);

  it('a worker that lost its claim neither deletes the new holder row nor publishes a result', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durlost${Date.now()}`;
    const tasks = `"${prefix}_transport_tasks"`;
    const results = `"${prefix}_transport_results"`;
    let started = false;
    const a = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: workerGroup,
      prefix,
      pollMs: 20,
      leaseMs: 300,
      instanceId: 'a',
    });
    a.handle(CHARGE_CARD_STEP_NAME, async () => {
      started = true;
      await sleep(600);
      return 'from-a';
    });
    await a.dispatch(remoteTask('s1'));
    while (!started) await sleep(10);
    // Another instance takes the row over while `a` is still running it (what a reclaim after `a`
    // went silent past leaseMs looks like).
    await ds.query(
      `UPDATE ${tasks} SET claimed_by = 'intruder', claimed_at = $1 WHERE step_id = 's1'`,
      [Date.now() + 60_000],
    );
    await sleep(1_000);
    await a.close();
    const left = await ds.query(`SELECT claimed_by FROM ${tasks} WHERE step_id = 's1'`);
    expect(left).toEqual([{ claimed_by: 'intruder' }]);
    expect(await ds.query(`SELECT step_id FROM ${results}`)).toEqual([]);
    await dropTables(prefix);
  }, 30_000);

  it('publishes the result and deletes the task in one transaction (no window for a retry to collide)', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `duratomic${Date.now()}`;
    const tasks = `"${prefix}_transport_tasks"`;
    const seen: Array<{ status: string; taskRowStillThere: boolean }> = [];
    // Widen the window between "result written" and "task row deleted": every statement that writes a
    // result row takes 100ms longer to return, inside or outside a transaction.
    const base = typeOrmExecutor(ds);
    const slowAfterResultInsert = async (sql: string) => {
      if (/^\s*INSERT/i.test(sql) && sql.includes('_transport_results')) await sleep(100);
    };
    const slow: typeof base = {
      ...base,
      query: async (sql, params) => {
        const out = await base.query(sql, params);
        await slowAfterResultInsert(sql);
        return out as never;
      },
      transaction: (fn) =>
        base.transaction((tx) =>
          fn({
            query: async (sql, params) => {
              const out = await tx.query(sql, params);
              await slowAfterResultInsert(sql);
              return out as never;
            },
          }),
        ),
    };
    const worker = new DbTransport({
      executor: slow,
      group: workerGroup,
      prefix,
      pollMs: 10,
    });
    worker.handle(CHARGE_CARD_STEP_NAME, async () => 'ok');
    const engineSide = new DbTransport({ executor: typeOrmExecutor(ds), prefix, pollMs: 5 });
    engineSide.onResult(async (r) => {
      const rows = await ds.query(`SELECT step_id FROM ${tasks} WHERE step_id = $1`, [r.stepId]);
      seen.push({ status: r.status, taskRowStillThere: rows.length > 0 });
    });
    for (let i = 0; i < 5; i += 1) await worker.dispatch(remoteTask(`s${i}`));
    const deadline = Date.now() + 10_000;
    while (seen.length < 5 && Date.now() < deadline) await sleep(20);
    await Promise.all([worker.close(), engineSide.close()]);
    expect(seen).toHaveLength(5);
    // The moment a result is visible the task row must be gone — otherwise the engine's retry
    // dispatch (same step_id) is swallowed by ON CONFLICT DO NOTHING and the late DELETE drops it.
    expect(seen.filter((s) => s.taskRowStillThere)).toEqual([]);
    await dropTables(prefix);
  }, 30_000);

  it('a newer result for the same step replaces the one still waiting, never dropped', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durresult${Date.now()}`;
    const delivered: string[] = [];
    let firstCall = true;
    const worker = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: workerGroup,
      prefix,
      pollMs: 10,
    });
    let attempt = 0;
    worker.handle(CHARGE_CARD_STEP_NAME, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return 'second';
    });
    const engineSide = new DbTransport({ executor: typeOrmExecutor(ds), prefix, pollMs: 10 });
    engineSide.onResult(async (r) => {
      delivered.push(r.status);
      if (firstCall) {
        firstCall = false;
        // The engine retries from inside the result handler, and the retry's result lands before
        // this handler returns (and before this result row is deleted).
        await engineSide.dispatch({ ...remoteTask('s1'), attempt: 2 });
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
          const rows = await ds.query(
            `SELECT status FROM "${prefix}_transport_results" WHERE step_id = 's1'`,
          );
          if (rows[0]?.status === 'completed') break;
          await sleep(20);
        }
      }
    });
    await worker.dispatch(remoteTask('s1'));
    const deadline = Date.now() + 10_000;
    while (delivered.length < 2 && Date.now() < deadline) await sleep(20);
    await Promise.all([worker.close(), engineSide.close()]);
    expect(delivered).toEqual(['failed', 'completed']);
    await dropTables(prefix);
  }, 30_000);

  it('a throwing result handler is reported and does not stop the results loop', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durthrow${Date.now()}`;
    const errors: unknown[] = [];
    const delivered: string[] = [];
    const worker = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: workerGroup,
      prefix,
      pollMs: 10,
    });
    worker.handle(CHARGE_CARD_STEP_NAME, async (input: { stepId: string }) => input.stepId);
    const engineSide = new DbTransport({
      executor: typeOrmExecutor(ds),
      prefix,
      pollMs: 10,
      leaseMs: 300,
      onError: (err) => errors.push(err),
    });
    let failedOnce = false;
    engineSide.onResult(async (r) => {
      if (r.stepId === 's1' && !failedOnce) {
        failedOnce = true;
        throw new Error('store down');
      }
      delivered.push(r.stepId);
    });
    await worker.dispatch(remoteTask('s1'));
    await worker.dispatch(remoteTask('s2'));
    const deadline = Date.now() + 10_000;
    while (delivered.length < 2 && Date.now() < deadline) await sleep(20);
    await Promise.all([worker.close(), engineSide.close()]);
    expect([...delivered].sort()).toEqual(['s1', 's2']);
    expect(errors.length).toBeGreaterThan(0);
    await dropTables(prefix);
  }, 30_000);
});
