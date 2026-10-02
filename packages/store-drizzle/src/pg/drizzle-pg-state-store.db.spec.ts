import {
  SINGLETON_ADMITTED_TAG,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import {
  type StateStoreContext,
  StateStoreUnavailableError,
  runStateStoreContract,
} from '@dudousxd/nestjs-durable-testing';
import { DbTransport } from '@dudousxd/nestjs-durable-transport-db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import pg from 'pg';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DURABLE_PG_DDL } from './ddl';
import { type DrizzlePgDatabase, DrizzlePgStateStore } from './drizzle-pg-state-store';
import { drizzlePgExecutor } from './executor';
import { durablePgManagedTables, durablePgSchema } from './schema';

/**
 * Real-Postgres matrix for the Drizzle Postgres store: the SHARED cross-store contract on BOTH common
 * drizzle Postgres drivers (node-postgres and postgres-js — they differ in how they hand back jsonb,
 * timestamps and affected-row counts), plus the Postgres-only guarantees the contract cannot see:
 * DDL ⇔ pgTable parity, atomic leases / takes under real concurrency, SKIP LOCKED claiming, retention,
 * tenant read scoping, and the DbTransport executor. Run with `pnpm test:db`.
 *
 * Uses a testcontainers `postgres:16-alpine` like the other stores' db specs, or — when
 * `DURABLE_TEST_PG_URL` is set — an existing database you point it at (the tables are created,
 * truncated between cases, and dropped at the end). Skips cleanly without Docker or with
 * `SKIP_TESTCONTAINERS` set.
 */

const CONTAINER_TIMEOUT = 180_000;
const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;

let container: StartedPostgreSqlContainer | undefined;
let url: string | undefined;
let bootError: unknown;
let pool: pg.Pool | undefined;
let sqlJs: postgres.Sql | undefined;
let nodePgDb: DrizzlePgDatabase | undefined;
let postgresJsDb: DrizzlePgDatabase | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    if (externalUrl) url = externalUrl;
    else {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = container.getConnectionUri();
    }
    pool = new pg.Pool({ connectionString: url, max: 10 });
    nodePgDb = drizzleNodePg(pool);
    sqlJs = postgres(url, { max: 10, onnotice: () => {} });
    postgresJsDb = drizzlePostgresJs(sqlJs);
    await dropDurableTables();
  } catch (err) {
    bootError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  if (!bootError && pool) await dropDurableTables().catch(() => undefined);
  await pool?.end();
  await sqlJs?.end();
  await container?.stop();
});

async function dropDurableTables(): Promise<void> {
  for (const t of durablePgManagedTables()) await pool?.query(`DROP TABLE IF EXISTS "${t}"`);
}

async function truncate(): Promise<void> {
  const tables = durablePgManagedTables()
    .map((t) => `"${t}"`)
    .join(', ');
  await pool?.query(`TRUNCATE ${tables} RESTART IDENTITY`);
}

function liveDb(driver: 'node-postgres' | 'postgres-js'): DrizzlePgDatabase {
  if (skipped) throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
  if (bootError)
    throw new StateStoreUnavailableError(
      `Postgres unavailable (is Docker running, or DURABLE_TEST_PG_URL reachable?): ${String(bootError)}`,
    );
  const db = driver === 'node-postgres' ? nodePgDb : postgresJsDb;
  if (!db) throw new StateStoreUnavailableError('Postgres not started');
  return db;
}

async function freshStore(
  driver: 'node-postgres' | 'postgres-js' = 'node-postgres',
): Promise<DrizzlePgStateStore> {
  const store = new DrizzlePgStateStore(liveDb(driver));
  await store.ensureSchema();
  await truncate();
  return store;
}

for (const driver of ['node-postgres', 'postgres-js'] as const) {
  describe(`Drizzle Postgres (${driver}) [real engine]`, () => {
    runStateStoreContract(
      `Drizzle Postgres (${driver})`,
      async (): Promise<StateStoreContext> => ({
        store: await freshStore(driver),
        peerStore: new DrizzlePgStateStore(
          liveDb(driver === 'node-postgres' ? 'postgres-js' : 'node-postgres'),
        ),
        cleanup: truncate,
      }),
    );

    it('round-trips jsonb scalars, arrays and nested payloads without double-encoding', async (ctx) => {
      if (!available()) return ctx.skip();
      const store = await freshStore(driver);
      const inputs: unknown[] = ['plain string', 42, true, [1, 'two'], { a: { b: [null, 3] } }];
      for (const [i, input] of inputs.entries())
        await store.createRun(run({ id: `j${i}`, input, tags: ['x'] }));
      for (const [i, input] of inputs.entries())
        expect((await store.getRun(`j${i}`))?.input).toEqual(input);
      // The column holds real jsonb, not a JSON-encoded string (the postgres-js double-encode trap).
      const res = await pool?.query(
        `SELECT jsonb_typeof(input) AS t FROM durable_workflow_runs WHERE id = 'j4'`,
      );
      expect(res?.rows[0]?.t).toBe('object');
      expect((await store.listRuns({ tag: 'x' })).length).toBe(inputs.length);
    });
  });
}

const at = new Date('2026-06-11T00:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'checkout',
    workflowVersion: '1',
    status: 'running',
    input: { orderId: 'o1' },
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function available(): boolean {
  return !skipped && !bootError && !!nodePgDb;
}

describe('Drizzle Postgres singleton admission [real engine]', () => {
  it('separate clients wait for a durable claim while another contender is inserted', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    const peer = new DrizzlePgStateStore(liveDb('postgres-js'));
    await store.createRun(run({ id: 'z-holder', tags: ['singleton:k'] }));
    await store.createRun(run({ id: 'b-waiter', tags: ['singleton:k'] }));
    if (!pool) throw new Error('Postgres pool unavailable');
    const connection = await pool.connect();
    const claims: Promise<boolean>[] = [];
    try {
      await connection.query('BEGIN');
      // Pause the holder transaction after persisting its claim but before commit.
      await connection.query('UPDATE durable_workflow_runs SET tags = $1::jsonb WHERE id = $2', [
        JSON.stringify(['singleton:k', SINGLETON_ADMITTED_TAG]),
        'z-holder',
      ]);
      claims.push(peer.tryAdmitSingleton('b-waiter', 'singleton:k', 'checkout', 1));
      // A new row is committed while the competing claim is waiting on the existing holder.
      await store.createRun(run({ id: 'a-later', tags: ['singleton:k'] }));
      claims.push(store.tryAdmitSingleton('a-later', 'singleton:k', 'checkout', 1));
      await connection.query('COMMIT');
      expect(await Promise.all(claims)).toEqual([false, false]);
      expect(await peer.tryAdmitSingleton('z-holder', 'singleton:k', 'checkout', 1)).toBe(true);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await Promise.allSettled(claims);
    }
  });

  it('scoped stores confine both claims and competing holders to their namespace', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    for (const namespace of ['alpha', 'beta']) {
      await store.createRun(run({ id: namespace, namespace, tags: ['singleton:k'] }));
    }
    const alpha = store.withScope({ namespace: 'alpha' });
    const beta = store.withScope({ namespace: 'beta' });
    expect(
      await Promise.all([
        alpha.tryAdmitSingleton('alpha', 'singleton:k', 'checkout', 1),
        beta.tryAdmitSingleton('beta', 'singleton:k', 'checkout', 1),
      ]),
    ).toEqual([true, true]);
    expect(await alpha.tryAdmitSingleton('beta', 'singleton:k', 'checkout', 1)).toBe(false);
    await alpha.updateRun('beta', { status: 'completed' });
    expect((await store.getRun('beta'))?.tags).toEqual(['singleton:k']);
  });
});

describe('Drizzle Postgres schema [real engine]', () => {
  it('ensureSchema is idempotent and safe to race from several pods', async (ctx) => {
    if (!available()) return ctx.skip();
    await dropDurableTables();
    const db = liveDb('node-postgres');
    await Promise.all([1, 2, 3, 4].map(() => new DrizzlePgStateStore(db).ensureSchema()));
    await new DrizzlePgStateStore(db).ensureSchema();
    const res = await pool?.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'durable\\_%'`,
    );
    expect(res?.rows.map((r) => r.table_name).sort()).toEqual(durablePgManagedTables().sort());
  });

  it('the shipped DDL creates exactly what the pgTable definitions declare', async (ctx) => {
    if (!available()) return ctx.skip();
    await new DrizzlePgStateStore(liveDb('node-postgres')).ensureSchema();
    // information_schema reports a bigserial as bigint + a nextval default.
    const infoType = (sqlType: string) => (sqlType === 'bigserial' ? 'bigint' : sqlType);
    for (const table of Object.values(durablePgSchema)) {
      const config = getTableConfig(table);
      const cols = await pool?.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1`,
        [config.name],
      );
      const live = new Map(cols?.rows.map((c) => [c.column_name as string, c]));
      expect([...live.keys()].sort(), config.name).toEqual(
        config.columns.map((c) => c.name).sort(),
      );
      for (const column of config.columns) {
        const actual = live.get(column.name);
        expect(actual?.data_type, `${config.name}.${column.name}`).toBe(
          infoType(column.getSQLType()),
        );
        expect(actual?.is_nullable === 'NO', `${config.name}.${column.name} NOT NULL`).toBe(
          column.notNull,
        );
        if (column.hasDefault && column.default !== undefined)
          expect(actual?.column_default).toContain(
            // Postgres reports a text default quoted ('default'), a boolean one bare (false).
            typeof column.default === 'string' ? `'${column.default}'` : String(column.default),
          );
      }
      const idx = await pool?.query(
        'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1',
        [config.name],
      );
      const liveIndexes = new Map(idx?.rows.map((r) => [r.indexname as string, r.indexdef]));
      const pkName = config.primaryKeys[0]?.getName() ?? `${config.name}_pkey`;
      const expected = [pkName, ...config.indexes.map((i) => i.config.name as string)].sort();
      expect([...liveIndexes.keys()].sort(), `${config.name} indexes`).toEqual(expected);
      for (const i of config.indexes) {
        const cols = i.config.columns.map((c) => ('name' in c ? c.name : ''));
        const def = liveIndexes.get(i.config.name as string) ?? '';
        for (const c of cols) expect(def).toContain(c);
        expect(def.toLowerCase()).toContain(`using ${i.config.method ?? 'btree'}`);
      }
    }
    expect(DURABLE_PG_DDL.join('\n')).toContain('jsonb_path_ops');
  });
});

describe('Drizzle Postgres concurrency [real engine]', () => {
  it('tryLockRun: of N racing instances exactly one wins, and an expired lease is re-takeable', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    await store.createRun(run());
    const now = at.getTime();
    const wins = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.tryLockRun('r1', `owner-${i}`, now + 1_000, now)),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
    // Lease still live: nobody else gets it; after expiry someone does.
    expect(await store.tryLockRun('r1', 'late', now + 5_000, now + 500)).toBe(false);
    expect(await store.tryLockRun('r1', 'late', now + 5_000, now + 1_000)).toBe(true);
    expect(await store.renewRunLock('r1', 'late', now + 9_000)).toBe(true);
    expect((await store.getRun('r1'))?.lockedUntil).toBe(now + 9_000);
  });

  it('takeSignalWaiter hands a waiter to exactly one concurrent taker', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    await store.putSignalWaiter({ token: 'approve:r1', runId: 'r1', seq: 3 });
    const taken = await Promise.all(
      Array.from({ length: 8 }, () => store.takeSignalWaiter('approve:r1')),
    );
    expect(taken.filter((w) => w !== null)).toEqual([{ token: 'approve:r1', runId: 'r1', seq: 3 }]);
  });

  it('takeBufferedSignal (SKIP LOCKED) gives concurrent takers distinct signals, never a duplicate', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    for (let i = 0; i < 5; i++) await store.bufferSignal('tok', { i });
    const taken = await Promise.all(
      Array.from({ length: 12 }, () => store.takeBufferedSignal('tok')),
    );
    const payloads = taken.filter((t) => t !== null).map((t) => (t?.payload as { i: number }).i);
    // Under SKIP LOCKED a taker that only sees locked rows gets null instead of waiting, so fewer
    // than 5 may be delivered in this burst — but never a duplicate, and nothing is lost.
    expect(new Set(payloads).size).toBe(payloads.length);
    let rest = await store.takeBufferedSignal('tok');
    while (rest) {
      payloads.push((rest.payload as { i: number }).i);
      rest = await store.takeBufferedSignal('tok');
    }
    expect(payloads.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('takeBufferedSignal is FIFO per token', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    await store.bufferSignal('a', 'first');
    await store.bufferSignal('b', 'other');
    await store.bufferSignal('a', 'second');
    expect(await store.takeBufferedSignal('a')).toEqual({ payload: 'first' });
    expect(await store.takeBufferedSignal('a')).toEqual({ payload: 'second' });
    expect(await store.takeBufferedSignal('a')).toBeNull();
  });

  it('LIKE prefixes are literal — `%`/`_` in a token never widen the match', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    await store.putSignalWaiter({ token: 'event:50%_off:1', runId: 'r1', seq: 0 });
    await store.putSignalWaiter({ token: 'event:50xyoff:2', runId: 'r2', seq: 0 });
    expect((await store.listSignalWaiters('event:50%_')).map((w) => w.runId)).toEqual(['r1']);
  });
});

describe('Drizzle Postgres pruneTerminalRuns [real engine]', () => {
  const now = at.getTime();
  const seed = async (store: DrizzlePgStateStore, id: string, status: string, ageDays: number) => {
    const ts = new Date(now - ageDays * day);
    await store.createRun(
      run({ id, status: status as WorkflowRun['status'], createdAt: ts, updatedAt: ts }),
    );
  };
  const ids = async (store: DrizzlePgStateStore) =>
    (await store.listRuns({})).map((r) => r.id).sort();

  it('prunes past maxAge (ms or duration string), keeps recent', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    await seed(store, 'old', 'completed', 30);
    await seed(store, 'fresh', 'completed', 1);
    expect(await store.pruneTerminalRuns({ statuses: ['completed'], maxAge: '7d' }, now, 100)).toBe(
      1,
    );
    expect(await ids(store)).toEqual(['fresh']);
  });

  it('prunes past maxCount, composes with maxAge most-restrictively, cascades children', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    await seed(store, 'old', 'completed', 30);
    await seed(store, 'mid', 'completed', 3);
    await seed(store, 'new', 'completed', 1);
    await seed(store, 'boom', 'failed', 30);
    await seed(store, 'live', 'running', 30);
    await store.saveCheckpoint({
      runId: 'old',
      seq: 0,
      name: 's',
      kind: 'local',
      stepId: 'old:0',
      status: 'completed',
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
    await store.putSignalWaiter({ token: 'w-old', runId: 'old', seq: 1 });
    // `running` in the policy is ignored — only terminal statuses are ever eligible.
    const deleted = await store.pruneTerminalRuns(
      { statuses: ['completed', 'running'], maxAge: 7 * day, maxCount: 1 },
      now,
      100,
    );
    expect(deleted).toBe(2); // old (age) + mid (count)
    expect(await ids(store)).toEqual(['boom', 'live', 'new']);
    expect(await store.listCheckpoints('old')).toEqual([]);
    expect(await store.listSignalWaiters('w-')).toEqual([]);
  });

  it('drains in bounded batches', async (ctx) => {
    if (!available()) return ctx.skip();
    const store = await freshStore();
    await seed(store, 'a', 'completed', 30);
    await seed(store, 'b', 'completed', 29);
    await seed(store, 'c', 'completed', 28);
    const policy = { statuses: ['completed' as const], maxAge: 7 * day };
    expect(await store.pruneTerminalRuns(policy, now, 2)).toBe(2);
    expect(await store.pruneTerminalRuns(policy, now, 2)).toBe(1);
    expect(await store.pruneTerminalRuns(policy, now, 2)).toBe(0);
  });
});

describe('Drizzle Postgres tenant scope (withScope) [real engine]', () => {
  it('a scoped view reads only its namespace on every run read path', async (ctx) => {
    if (!available()) return ctx.skip();
    const operator = await freshStore();
    await operator.createRun(
      run({ id: 'a1', namespace: 'tenant-a', status: 'pending', tags: ['t'] }),
    );
    await operator.createRun(
      run({
        id: 'b1',
        namespace: 'tenant-b',
        status: 'pending',
        tags: ['t'],
        searchAttributes: { plan: 'pro' },
      }),
    );
    const a = operator.withScope({ namespace: 'tenant-a' });
    expect(await a.getRun('b1')).toBeNull();
    expect((await a.getRun('a1'))?.namespace).toBe('tenant-a');
    expect((await a.listRuns({ tag: 't' })).map((r) => r.id)).toEqual(['a1']);
    expect(await a.listRuns({ attributes: [{ key: 'plan', op: 'eq', value: 'pro' }] })).toEqual([]);
    expect((await a.listPendingRuns(10)).map((r) => r.id)).toEqual(['a1']);
    expect(await a.runFacets({})).toEqual([{ status: 'pending', origin: null, count: 1 }]);
    // The operator (unscoped) view still sees both; scoping is a view, not a copy.
    expect((await operator.listRuns({})).length).toBe(2);
    expect((await a.withScope({ namespace: undefined }).listRuns({})).length).toBe(2);
  });
});

describe('drizzlePgExecutor + DbTransport [real engine]', () => {
  it('dispatches a remote step through the DB (FOR UPDATE SKIP LOCKED claim) end to end', async (ctx) => {
    if (!available()) return ctx.skip();
    const db = liveDb('node-postgres');
    const store = await freshStore();
    const prefix = `drz${Date.now()}`;
    const transport = new DbTransport({
      executor: drizzlePgExecutor(db),
      group: 'payments.charge-card',
      prefix,
      pollMs: 25,
    });
    transport.handle('payments.charge-card', async (input: unknown) => ({
      chargeId: `ch_${(input as { amount: number }).amount}`,
    }));
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.step<{ chargeId: string }>('payments.charge-card', { amount: 7 });
      return charge.chargeId;
    });
    try {
      await engine.start('checkout', {}, `run-${prefix}`);
      const deadline = Date.now() + 20_000;
      let done: WorkflowRun | null = null;
      while (Date.now() < deadline) {
        done = await store.getRun(`run-${prefix}`);
        if (done && ['completed', 'failed', 'cancelled', 'dead'].includes(done.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(done?.status).toBe('completed');
      expect(done?.output).toBe('ch_7');
      expect((await store.listCheckpoints(`run-${prefix}`)).at(-1)?.status).toBe('completed');
    } finally {
      await transport.close();
      await pool?.query(`DROP TABLE IF EXISTS "${prefix}_transport_tasks"`);
      await pool?.query(`DROP TABLE IF EXISTS "${prefix}_transport_results"`);
    }
  }, 30_000);
});

describe('Drizzle Postgres engine durability [real engine]', () => {
  it('a human-approval turn survives an engine restart: sleep, signal and a drizzle-tx step', async (ctx) => {
    if (!available()) return ctx.skip();
    const db = liveDb('node-postgres');
    const store = await freshStore();
    await pool?.query('CREATE TABLE IF NOT EXISTS durable_test_drafts (run_id text PRIMARY KEY)');
    await pool?.query('TRUNCATE durable_test_drafts');
    let drafts = 0;
    const body = async (c: WorkflowCtx) => {
      // Exactly-once business write: the Drizzle tx the store hands over commits WITH the checkpoint.
      const draft = await c.transaction('draft', async (tx) => {
        drafts++;
        await (tx as DrizzlePgDatabase).execute(
          sql`INSERT INTO durable_test_drafts (run_id) VALUES (${c.runId})`,
        );
        return `draft-for-${c.runId}`;
      });
      await c.sleep(50);
      const decision = await c.waitForSignal<{ approved: boolean }>(`approve:${c.runId}`);
      return { draft, approved: decision.approved };
    };

    // Instance A starts the turn and "dies" while it sleeps.
    const a = new WorkflowEngine({ store });
    a.register('approval-turn', '1', body);
    await a.start('approval-turn', {}, 'turn-1');
    expect((await a.waitForRun('turn-1', { timeoutMs: 20_000 })).status).toBe('suspended');

    // Instance B (fresh process, same database) resumes the due timer, then takes the approval.
    const b = new WorkflowEngine({ store });
    b.register('approval-turn', '1', body);
    await new Promise((r) => setTimeout(r, 80));
    await b.resumeDueTimers();
    expect((await b.waitForRun('turn-1', { timeoutMs: 20_000 })).status).toBe('suspended');
    expect((await store.listSignalWaiters('approve:')).map((w) => w.runId)).toEqual(['turn-1']);
    await b.signal('approve:turn-1', { approved: true });

    const done = await b.waitForRun('turn-1', { timeoutMs: 20_000 });
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ draft: 'draft-for-turn-1', approved: true });
    expect(drafts).toBe(1); // replayed from its checkpoint, never re-executed
    const rows = await pool?.query('SELECT count(*)::int AS n FROM durable_test_drafts');
    expect(rows?.rows[0]?.n).toBe(1);
    await pool?.query('DROP TABLE durable_test_drafts');
  }, 30_000);
});
