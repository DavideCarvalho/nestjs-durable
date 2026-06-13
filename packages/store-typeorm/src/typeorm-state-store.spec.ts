import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { DataSource } from 'typeorm';
import { ENTITIES } from './entities';
import { TypeOrmStateStore } from './typeorm-state-store';

async function makeStore() {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [...ENTITIES],
    synchronize: true,
  });
  await dataSource.initialize();
  return { store: new TypeOrmStateStore(dataSource), dataSource };
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

describe('TypeOrmStateStore', () => {
  it('ensureSchema creates the tables on a fresh database (no synchronize)', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [...ENTITIES],
      synchronize: false,
    });
    await dataSource.initialize();
    const store = new TypeOrmStateStore(dataSource);

    await store.ensureSchema();

    // Tables now exist: a write/read round-trips without "no such table".
    await store.createRun(run());
    expect((await store.getRun('r1'))?.workflow).toBe('checkout');
    await dataSource.destroy();
  });

  it('creates indexes for the timer poller and dashboard queries', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [...ENTITIES],
      synchronize: false,
    });
    await dataSource.initialize();
    await new TypeOrmStateStore(dataSource).ensureSchema();

    const indexes = (await dataSource.query(
      `PRAGMA index_list("durable_workflow_runs")`,
    )) as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('durable_runs_status_idx'); // timer poller / recovery
    expect(names).toContain('durable_runs_workflow_status_idx'); // dashboard listRuns
    await dataSource.destroy();
  });

  it('self-heals a pre-existing table that predates the events column', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [...ENTITIES],
      synchronize: false,
    });
    await dataSource.initialize();
    // Simulate an older deploy: the checkpoints table exists but lacks `events` (and `enqueuedAt`).
    await dataSource.query(
      `CREATE TABLE "durable_step_checkpoints" (
        "runId" varchar(191) NOT NULL, "seq" integer NOT NULL,
        "name" varchar(191) NOT NULL, "kind" varchar(191) NOT NULL, "stepId" varchar(191) NOT NULL,
        "status" varchar(191) NOT NULL, "input" text, "output" text, "error" text,
        "attempts" integer NOT NULL, "workerGroup" varchar(191),
        "wakeAt" datetime, "startedAt" datetime NOT NULL, "finishedAt" datetime NOT NULL,
        PRIMARY KEY ("runId", "seq")
      )`,
    );
    const store = new TypeOrmStateStore(dataSource);

    await store.ensureSchema(); // adds the missing `events` + `enqueuedAt` columns

    await store.createRun(run());
    await store.saveCheckpoint(
      checkpoint({
        events: [{ at: 1, level: 'error', message: 'p-3 failed', name: 'p-3', status: 'failed' }],
      }),
    );
    expect((await store.getCheckpoint('r1', 0))?.events).toEqual([
      { at: 1, level: 'error', message: 'p-3 failed', name: 'p-3', status: 'failed' },
    ]);
    await dataSource.destroy();
  });

  it('persists a run with JSON input and reads it back', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run());
    const loaded = await store.getRun('r1');
    expect(loaded?.workflow).toBe('checkout');
    expect(loaded?.input).toEqual({ orderId: 'o1' });
    await dataSource.destroy();
  });

  it('upserts checkpoints and reads them by (runId, seq)', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint());
    await store.saveCheckpoint(
      checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
    );
    expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true });
    expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
    expect(await store.listCheckpoints('r1')).toHaveLength(2);
    await dataSource.destroy();
  });

  it('lists incomplete runs and due timers', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'running1', status: 'running' }));
    await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
    await store.createRun(run({ id: 'done1', status: 'completed' }));
    expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
    expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
    expect(await store.listDueTimers(1_000)).toHaveLength(0);
    await dataSource.destroy();
  });

  it('tryLockRun is atomic and respects lease expiry', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'r1' }));
    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
    expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
    expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true);
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
    await dataSource.destroy();
  });

  it('stores and atomically takes a signal waiter', async () => {
    const { store, dataSource } = await makeStore();
    await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
    expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
    expect(await store.takeSignalWaiter('approve-1')).toBeNull();
    await dataSource.destroy();
  });

  it('runs the engine end-to-end durably, resuming without re-running steps', async () => {
    const { store, dataSource } = await makeStore();
    const engine = new WorkflowEngine({ store });
    let aRuns = 0;
    let failOnce = true;
    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.step('a', async () => {
        aRuns += 1;
        return 10;
      });
      const b = await ctx.step('b', async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return a + 5;
      });
      return b;
    });
    expect((await engine.start('wf', { x: 1 }, 'run1')).status).toBe('failed');
    const resumed = await engine.resume('run1');
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(15);
    expect(aRuns).toBe(1);
    await dataSource.destroy();
  });
});
