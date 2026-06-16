import {
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { DataSource } from 'typeorm';
import { ENTITIES } from './entities';
import { JSON_BLOB_COLUMNS, buildWidenStatements, jsonBlobColumnType } from './schema';
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

  it('round-trips recoveryAttempts and the dead status', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ recoveryAttempts: 3 }));
    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(3);
    await store.updateRun('r1', { status: 'dead', recoveryAttempts: 4 });
    const dead = await store.getRun('r1');
    expect(dead?.status).toBe('dead');
    expect(dead?.recoveryAttempts).toBe(4);
    await dataSource.destroy();
  });

  it('round-trips tags and filters listRuns by an exact tag (no substring match)', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'a', tags: ['etl', 'critical'] }));
    await store.createRun(run({ id: 'b', tags: ['etl-foo'] }));
    await store.createRun(run({ id: 'c' })); // no tags

    expect((await store.getRun('a'))?.tags).toEqual(['etl', 'critical']);
    expect((await store.listRuns({ tag: 'etl' })).map((r) => r.id)).toEqual(['a']);
    expect((await store.listRuns({ tag: 'etl-foo' })).map((r) => r.id)).toEqual(['b']);
    expect(await store.listRuns({ tag: 'nope' })).toHaveLength(0);
    await dataSource.destroy();
  });

  it('round-trips searchAttributes and filters listRuns by typed/range queries', async () => {
    const { store, dataSource } = await makeStore();
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

  it('transaction commits the checkpoint atomically and returns the work result', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run());
    const result = await store.transaction!(async (tx) => {
      await tx.saveCheckpoint(checkpoint({ seq: 7, name: 'tx-step', output: { paid: true } }));
      return 'ok';
    });
    expect(result).toBe('ok');
    const cp = await store.getCheckpoint('r1', 7);
    expect(cp?.name).toBe('tx-step');
    expect(cp?.output).toEqual({ paid: true });
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
    await engine.start('wf', { x: 1 }, 'run1');
    expect((await engine.waitForRun('run1')).status).toBe('failed');
    const resumed = await engine.resume('run1');
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(15);
    expect(aRuns).toBe(1);
    await dataSource.destroy();
  });
});

describe('MySQL longtext schema (DDL generation)', () => {
  const quote = (id: string) => `\`${id}\``;

  it('uses longtext (not text) for JSON-blob columns on MySQL', () => {
    expect(jsonBlobColumnType(true)).toBe('longtext');
  });

  it('uses plain text for the JSON-blob columns on Postgres/SQLite', () => {
    expect(jsonBlobColumnType(false)).toBe('text');
  });

  it('lists the big JSON blobs (events/output/input/error) but not keyed varchar columns', () => {
    expect(JSON_BLOB_COLUMNS.durable_step_checkpoints).toEqual(
      expect.arrayContaining(['input', 'output', 'error', 'events']),
    );
    expect(JSON_BLOB_COLUMNS.durable_workflow_runs).toEqual(
      expect.arrayContaining(['input', 'output', 'error']),
    );
    // Keyed/short string columns (MySQL can't index longtext) must NOT be widened.
    const all = [
      ...JSON_BLOB_COLUMNS.durable_step_checkpoints,
      ...JSON_BLOB_COLUMNS.durable_workflow_runs,
    ];
    for (const keyed of ['runId', 'seq', 'name', 'kind', 'stepId', 'status', 'id', 'workflow']) {
      expect(all).not.toContain(keyed);
    }
  });

  it('emits idempotent MODIFY ... longtext widen statements for existing MySQL tables', () => {
    const stmts = buildWidenStatements(true, quote);
    // Every JSON-blob column on both tables gets a MODIFY-to-longtext.
    expect(stmts).toContain('ALTER TABLE `durable_step_checkpoints` MODIFY COLUMN `events` longtext');
    expect(stmts).toContain('ALTER TABLE `durable_step_checkpoints` MODIFY COLUMN `output` longtext');
    expect(stmts).toContain('ALTER TABLE `durable_workflow_runs` MODIFY COLUMN `input` longtext');
    expect(stmts).toContain('ALTER TABLE `durable_workflow_runs` MODIFY COLUMN `error` longtext');
    expect(stmts.every((s) => s.includes('longtext'))).toBe(true);
    expect(stmts).toHaveLength(
      JSON_BLOB_COLUMNS.durable_step_checkpoints.length +
        JSON_BLOB_COLUMNS.durable_workflow_runs.length,
    );
  });

  it('emits no widen statements on non-MySQL dialects (text is already unbounded)', () => {
    expect(buildWidenStatements(false, quote)).toEqual([]);
  });
});
