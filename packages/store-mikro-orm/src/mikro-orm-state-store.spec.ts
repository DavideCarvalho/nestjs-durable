import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { MikroORM } from '@mikro-orm/better-sqlite';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

async function makeStore() {
  const orm = await MikroORM.init({
    dbName: ':memory:',
    entities: [...ENTITIES],
    allowGlobalContext: true,
  });
  await orm.schema.createSchema();
  return { store: new MikroOrmStateStore(orm), orm };
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

describe('MikroOrmStateStore', () => {
  it('ensureSchema creates the tables on a fresh database', async () => {
    const orm = await MikroORM.init({
      dbName: ':memory:',
      entities: [...ENTITIES],
      allowGlobalContext: true,
    });
    const store = new MikroOrmStateStore(orm);

    await store.ensureSchema();

    await store.createRun(run());
    expect((await store.getRun('r1'))?.workflow).toBe('checkout');
    await orm.close(true);
  });

  it('persists a run with JSON input and reads it back', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run());
    const loaded = await store.getRun('r1');
    expect(loaded?.workflow).toBe('checkout');
    expect(loaded?.input).toEqual({ orderId: 'o1' });
    expect(loaded?.status).toBe('running');
    await orm.close(true);
  });

  it('upserts checkpoints and reads them by (runId, seq)', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint());
    await store.saveCheckpoint(
      checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
    );

    expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true });
    expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
    expect(await store.listCheckpoints('r1')).toHaveLength(2);
    await orm.close(true);
  });

  it('lists incomplete runs and due timers', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'running1', status: 'running' }));
    await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
    await store.createRun(run({ id: 'done1', status: 'completed' }));

    expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
    expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
    expect(await store.listDueTimers(1_000)).toHaveLength(0);
    await orm.close(true);
  });

  it('tryLockRun is atomic and respects lease expiry', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'r1' }));
    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
    expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
    expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true); // lease expired at 2000
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
    await orm.close(true);
  });

  it('stores and atomically takes a signal waiter', async () => {
    const { store, orm } = await makeStore();
    await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
    expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
    expect(await store.takeSignalWaiter('approve-1')).toBeNull();
    await orm.close(true);
  });

  it('runs the engine end-to-end durably on SQLite, resuming without re-running steps', async () => {
    const { store, orm } = await makeStore();
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
    expect(aRuns).toBe(1); // 'a' replayed from the SQLite checkpoint, not re-run
    await orm.close(true);
  });
});
