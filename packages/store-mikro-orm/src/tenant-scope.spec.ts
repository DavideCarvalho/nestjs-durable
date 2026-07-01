import type { WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { MikroORM } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

const now = new Date('2026-06-30T00:00:00.000Z');

function run(over: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'x',
    workflow: 'w',
    workflowVersion: '1',
    status: 'pending',
    input: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

async function makeOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init({
    dbName: ':memory:',
    entities: [...ENTITIES],
    allowGlobalContext: true,
  });
  await orm.schema.create();
  return orm;
}

describe('MikroOrmStateStore tenant scope', () => {
  it('a namespace-scoped store cannot read another namespace run via getRun', async () => {
    const orm = await makeOrm();

    const operator = new MikroOrmStateStore(orm);
    await operator.createRun(run({ id: 'r-a', namespace: 'a' }));
    await operator.createRun(run({ id: 'r-b', namespace: 'b' }));

    const scopedToA = new MikroOrmStateStore(orm, { scope: { namespace: 'a' } });
    expect(await scopedToA.getRun('r-a')).not.toBeNull();
    expect(await scopedToA.getRun('r-b')).toBeNull();

    await orm.close(true);
  });

  it('a namespace-scoped store lists only its own namespace runs', async () => {
    const orm = await makeOrm();

    const operator = new MikroOrmStateStore(orm);
    await operator.createRun(run({ id: 'r-a', namespace: 'a' }));
    await operator.createRun(run({ id: 'r-b', namespace: 'b' }));

    const scopedToA = new MikroOrmStateStore(orm, { scope: { namespace: 'a' } });
    const listed = await scopedToA.listRuns({});
    expect(listed.map((r) => r.id)).toEqual(['r-a']);

    await orm.close(true);
  });

  it('an unscoped store sees all namespaces', async () => {
    const orm = await makeOrm();

    const operator = new MikroOrmStateStore(orm);
    await operator.createRun(run({ id: 'r-a', namespace: 'a' }));
    await operator.createRun(run({ id: 'r-b', namespace: 'b' }));

    const unscoped = new MikroOrmStateStore(orm);
    const listed = await unscoped.listRuns({});
    expect(listed.length).toBe(2);

    await orm.close(true);
  });

  it('a namespace-scoped store does not see pending runs from another namespace', async () => {
    const orm = await makeOrm();

    const operator = new MikroOrmStateStore(orm);
    await operator.createRun(run({ id: 'r-a', namespace: 'a', status: 'pending' }));
    await operator.createRun(run({ id: 'r-b', namespace: 'b', status: 'pending' }));

    const scopedToA = new MikroOrmStateStore(orm, { scope: { namespace: 'a' } });
    const pending = await scopedToA.listPendingRuns(10);
    expect(pending.map((r) => r.id)).toEqual(['r-a']);

    await orm.close(true);
  });
});
