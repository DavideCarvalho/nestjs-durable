import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DrizzleStateStore } from './drizzle-state-store';
import { durableSchema } from './schema';

const DDL = `
CREATE TABLE durable_workflow_runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, workflow_version TEXT NOT NULL, status TEXT NOT NULL,
  input TEXT, output TEXT, error TEXT, wake_at INTEGER, locked_by TEXT, locked_until INTEGER,
  recovery_attempts INTEGER, tags TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE durable_step_checkpoints (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, step_id TEXT NOT NULL,
  status TEXT NOT NULL, input TEXT, output TEXT, error TEXT, events TEXT, attempts INTEGER NOT NULL, worker_group TEXT, wake_at INTEGER,
  enqueued_at INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TABLE durable_signal_waiters (token TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL);
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
    expect((await engine.start('wf', { x: 1 }, 'run1')).status).toBe('failed');
    const resumed = await engine.resume('run1');
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(15);
    expect(aRuns).toBe(1);
    sqlite.close();
  });
});
