import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { runStateStoreContract } from '@dudousxd/nestjs-durable-testing';
import { MikroORM } from '@mikro-orm/sqlite';
import { makeMikroOrmStoreFactory } from './conformance';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

// The SHARED cross-store behavioral contract, run here against SQLite (default `pnpm test`). The same
// contract runs against real Postgres/MySQL in `mikro-orm-state-store.db.spec.ts` under `pnpm test:db`.
runStateStoreContract(
  'MikroORM (sqlite)',
  makeMikroOrmStoreFactory((options) => MikroORM.init(options), { dbName: ':memory:' }),
);

async function makeStore() {
  const orm = await MikroORM.init({
    dbName: ':memory:',
    entities: [...ENTITIES],
    allowGlobalContext: true,
  });
  await orm.schema.create();
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

  it('round-trips searchAttributes and answers equality + range queries (pushdown)', async () => {
    const { store, orm } = await makeStore();
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
    await orm.close(true);
  });

  it('pushes attribute predicates DOWN into SQL via EXISTS on the side-table', async () => {
    const sqls: string[] = [];
    const orm = await MikroORM.init({
      dbName: ':memory:',
      entities: [...ENTITIES],
      allowGlobalContext: true,
      debug: true,
      logger: (msg: string) => sqls.push(msg),
    });
    await orm.schema.create();
    const store = new MikroOrmStateStore(orm);
    await store.createRun(run({ id: 'a', searchAttributes: { amount: 30 } }));
    await store.createRun(run({ id: 'b', searchAttributes: { amount: 200 } }));

    sqls.length = 0;
    const res = await store.listRuns({
      attributes: [{ key: 'amount', op: 'gte', value: 100 }],
      limit: 10,
    });
    expect(res.map((r) => r.id)).toEqual(['b']);
    const select = sqls.find((s) => /select/i.test(s) && /durable_workflow_runs/i.test(s));
    expect(select).toBeDefined();
    expect(select).toMatch(/exists/i); // predicate pushed into SQL, not filtered in-process
    expect(select).toMatch(/durable_run_attributes/i);
    expect(select).toMatch(/limit/i); // pagination pushed to the DB
    await orm.close(true);
  });

  it('maintains the side-table on create and re-indexes on update', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 10 } }));
    const created = await orm.em
      .fork()
      .getConnection()
      .execute(
        `SELECT "key", "str_value" AS "strValue", "num_value" AS "numValue" FROM "durable_run_attributes" WHERE "run_id" = 'a' ORDER BY "key"`,
      );
    expect(created).toEqual([
      { key: 'amount', strValue: null, numValue: 10 },
      { key: 'tier', strValue: 'free', numValue: null },
    ]);

    await store.updateRun('a', { searchAttributes: { tier: 'pro' } });
    expect(
      (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).map(
        (r) => r.id,
      ),
    ).toEqual(['a']);
    expect(
      await store.listRuns({ attributes: [{ key: 'amount', op: 'eq', value: 10 }] }),
    ).toHaveLength(0);
    expect(
      await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] }),
    ).toHaveLength(0);
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

    await engine.start('wf', { x: 1 }, 'run1');
    expect((await engine.waitForRun('run1')).status).toBe('failed');
    const resumed = await engine.resume('run1');

    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(15);
    expect(aRuns).toBe(1); // 'a' replayed from the SQLite checkpoint, not re-run
    await orm.close(true);
  });
});
