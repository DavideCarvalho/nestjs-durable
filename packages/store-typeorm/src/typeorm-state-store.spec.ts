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
