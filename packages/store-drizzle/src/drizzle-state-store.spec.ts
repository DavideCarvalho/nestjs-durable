import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { runStateStoreContract } from '@dudousxd/nestjs-durable-testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DrizzleStateStore } from './drizzle-state-store';
import { durableSchema } from './schema';

// The SHARED cross-store behavioral contract, run against SQLite. NOTE: this Drizzle adapter is
// SQLite/libSQL-only by design — `./schema` stores timestamps as epoch-ms INTEGER columns and uses
// SQLite-specific `onConflictDoUpdate`, so it has no Postgres/MySQL `.db.spec.ts`. For PG/MySQL use
// the TypeORM, MikroORM or Prisma adapters (which DO run in the `pnpm test:db` matrix).
runStateStoreContract('Drizzle (better-sqlite3, SQLite-only)', async () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  const db = drizzle(sqlite, { schema: durableSchema });
  return {
    store: new DrizzleStateStore(db),
    // better-sqlite3 is synchronous: its `transaction()` rejects an async callback, so the contract's
    // transaction case is skipped here (it runs for every other store). libSQL (async) would support it.
    supportsAsyncTransaction: false,
    cleanup: async () => {
      sqlite.close();
    },
  };
});

const DDL = `
CREATE TABLE durable_workflow_runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, workflow_version TEXT NOT NULL, status TEXT NOT NULL,
  input TEXT, output TEXT, error TEXT, wake_at INTEGER, locked_by TEXT, locked_until INTEGER,
  awaiting_decision_task_id TEXT,
  recovery_attempts INTEGER, tags TEXT, search_attributes TEXT, priority INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE durable_step_checkpoints (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, step_id TEXT NOT NULL,
  status TEXT NOT NULL, input TEXT, output TEXT, error TEXT, events TEXT, attempts INTEGER NOT NULL, worker_group TEXT, parallel_group TEXT, wake_at INTEGER,
  enqueued_at INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TABLE durable_run_attributes (
  run_id TEXT NOT NULL, key TEXT NOT NULL, str_value TEXT, num_value REAL, PRIMARY KEY (run_id, key)
);
CREATE INDEX durable_run_attributes_num_idx ON durable_run_attributes (key, num_value);
CREATE INDEX durable_run_attributes_str_idx ON durable_run_attributes (key, str_value);
CREATE TABLE durable_signal_waiters (token TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, parallel_group TEXT);
CREATE TABLE durable_buffered_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, payload TEXT);
`;

function makeStore() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  const db = drizzle(sqlite, { schema: durableSchema });
  return { store: new DrizzleStateStore(db), sqlite };
}

const at = new Date('2026-06-11T00:00:00.000Z');
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'running',
  input: { orderId: 'o1' },
  createdAt: at,
  updatedAt: at,
  ...over,
});
const checkpoint = (over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
  runId: 'r1',
  seq: 0,
  name: 'reserve',
  kind: 'local',
  stepId: 'r1:0',
  status: 'completed',
  output: { ok: true },
  attempts: 1,
  startedAt: at,
  finishedAt: at,
  ...over,
});

describe('DrizzleStateStore', () => {
  it('persists a run with JSON input and reads it back', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run());
    const loaded = await store.getRun('r1');
    expect(loaded?.workflow).toBe('checkout');
    expect(loaded?.input).toEqual({ orderId: 'o1' });
    sqlite.close();
  });

  it('upserts checkpoints and reads them by (runId, seq)', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint());
    await store.saveCheckpoint(
      checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
    );
    expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true });
    expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
    expect(await store.listCheckpoints('r1')).toHaveLength(2);
    sqlite.close();
  });

  it('lists incomplete runs and due timers', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'running1', status: 'running' }));
    await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
    await store.createRun(run({ id: 'done1', status: 'completed' }));
    expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
    expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
    expect(await store.listDueTimers(1_000)).toHaveLength(0);
    sqlite.close();
  });

  it('lists pending runs oldest-first (FIFO), capped at the limit', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'p2', status: 'pending', createdAt: new Date(2000) }));
    await store.createRun(run({ id: 'p1', status: 'pending', createdAt: new Date(1000) }));
    await store.createRun(run({ id: 'p3', status: 'pending', createdAt: new Date(3000) }));
    await store.createRun(run({ id: 'running1', status: 'running' }));
    expect((await store.listPendingRuns(10)).map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    expect((await store.listPendingRuns(2)).map((r) => r.id)).toEqual(['p1', 'p2']);
    sqlite.close();
  });

  it('tryLockRun is atomic and respects lease expiry', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'r1' }));
    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
    expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
    expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true);
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
    sqlite.close();
  });

  it('stores and atomically takes a signal waiter', async () => {
    const { store, sqlite } = makeStore();
    await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
    expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
    expect(await store.takeSignalWaiter('approve-1')).toBeNull();
    sqlite.close();
  });

  it('round-trips searchAttributes and answers equality + range queries', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', searchAttributes: { amount: 30, tier: 'free' } }));
    await store.createRun(run({ id: 'b', searchAttributes: { amount: 200, tier: 'pro' } }));
    await store.createRun(run({ id: 'c', searchAttributes: { amount: 500, tier: 'pro' } }));

    expect((await store.getRun('b'))?.searchAttributes).toEqual({ amount: 200, tier: 'pro' });
    const big = await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 200 }] });
    expect(big.map((r) => r.id).sort()).toEqual(['b', 'c']);
    const proSmall = await store.listRuns({
      attributes: [
        { key: 'tier', op: 'eq', value: 'pro' },
        { key: 'amount', op: 'lt', value: 300 },
      ],
    });
    expect(proSmall.map((r) => r.id)).toEqual(['b']);
    // `ne` excludes the matching value AND absent keys (missing-key-never-matches contract).
    const notFree = await store.listRuns({
      attributes: [{ key: 'tier', op: 'ne', value: 'free' }],
    });
    expect(notFree.map((r) => r.id).sort()).toEqual(['b', 'c']);
    sqlite.close();
  });

  it('pushes attribute predicates DOWN into SQL via EXISTS on the side-table (no full scan)', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', searchAttributes: { amount: 30 } }));
    await store.createRun(run({ id: 'b', searchAttributes: { amount: 200 } }));

    // Capture the SQL better-sqlite3 actually executes for the query.
    const sqls: string[] = [];
    sqlite.function('__noop', () => 0); // ensure db is usable
    const orig = sqlite.prepare.bind(sqlite);
    (sqlite as unknown as { prepare: typeof orig }).prepare = (s: string) => {
      sqls.push(s);
      return orig(s);
    };

    const res = await store.listRuns({
      attributes: [{ key: 'amount', op: 'gte', value: 100 }],
      limit: 10,
    });
    expect(res.map((r) => r.id)).toEqual(['b']);
    const select = sqls.find((s) => /select/i.test(s) && /durable_workflow_runs/i.test(s));
    expect(select).toBeDefined();
    expect(select).toMatch(/exists/i); // predicate pushed into SQL, not filtered in-process
    expect(select).toMatch(/durable_run_attributes/i);
    expect(select).toMatch(/limit/i); // pagination pushed to the DB, not done in-process
    sqlite.close();
  });

  it('maintains the side-table on create and re-indexes on update', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 10 } }));
    const rowsAfterCreate = sqlite
      .prepare(
        `SELECT key, str_value AS strValue, num_value AS numValue FROM durable_run_attributes WHERE run_id = 'a' ORDER BY key`,
      )
      .all();
    expect(rowsAfterCreate).toEqual([
      { key: 'amount', strValue: null, numValue: 10 },
      { key: 'tier', strValue: 'free', numValue: null },
    ]);

    await store.updateRun('a', { searchAttributes: { tier: 'pro' } });
    expect(
      (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).map(
        (r) => r.id,
      ),
    ).toEqual(['a']);
    // Old rows gone after reindex.
    expect(
      await store.listRuns({ attributes: [{ key: 'amount', op: 'eq', value: 10 }] }),
    ).toHaveLength(0);
    expect(
      await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] }),
    ).toHaveLength(0);
    sqlite.close();
  });

  it('runs the engine end-to-end durably, resuming without re-running steps', async () => {
    const { store, sqlite } = makeStore();
    const engine = new WorkflowEngine({ store });
    let aRuns = 0;
    let failOnce = true;
    engine.register('wf', '1', async (c) => {
      const a = await c.step('a', async () => {
        aRuns += 1;
        return 10;
      });
      return c.step('b', async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return a + 5;
      });
    });
    await engine.start('wf', { x: 1 }, 'run1');
    expect((await engine.waitForRun('run1')).status).toBe('failed');
    const resumed = await engine.resume('run1');
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(15);
    expect(aRuns).toBe(1);
    sqlite.close();
  });
});
