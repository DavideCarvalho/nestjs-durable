import { type WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { MikroORM } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

const now = new Date('2026-06-26T00:00:00.000Z');
const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 'x', workflow: 'w', workflowVersion: '1', status: 'pending',
  input: {}, createdAt: now, updatedAt: now, ...over,
});

async function makeStore() {
  const orm = await MikroORM.init({ dbName: ':memory:', entities: [...ENTITIES], allowGlobalContext: true });
  await orm.schema.create();
  return { store: new MikroOrmStateStore(orm), orm };
}

describe('MikroOrmStateStore namespace', () => {
  it('persists namespace and filters list methods; defaults to "default"', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));
    await store.createRun(run({ id: 'b', namespace: 'beta' }));
    await store.createRun(run({ id: 'c' })); // no namespace -> defaults to 'default'

    expect((await store.getRun('a'))?.namespace).toBe('alpha');
    expect((await store.getRun('c'))?.namespace).toBe('default');
    expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    await orm.close(true);
  });

  it('filters listIncompleteRuns and listDueTimers', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'r', status: 'running', namespace: 'alpha' }));
    await store.createRun(run({ id: 's', status: 'running', namespace: 'beta' }));
    await store.createRun(run({ id: 't', status: 'suspended', namespace: 'alpha', wakeAt: now.getTime() - 1 }));

    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['r']);
    expect((await store.listDueTimers(now.getTime(), 'alpha')).map((r) => r.id)).toEqual(['t']);
    await orm.close(true);
  });
});
