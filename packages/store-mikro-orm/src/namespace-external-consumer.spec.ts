import type { WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { MikroORM } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { ENTITIES, WorkflowRunEntity } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';
import { WorkflowRunRepository } from './repositories';

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

// An operator app (flip) shares its ORM with the store and reads WorkflowRunEntity directly through
// the APP's EntityManager — it never goes through the store's fork() and so never sets the `namespace`
// filter param. That must NOT force the app to set the param (the filter is opt-in scoping, off unless
// the store activates it), so a direct query sees every run.
describe('namespace filter — external (operator) consumer', () => {
  it('a direct app-em query on WorkflowRunEntity works without setting the filter param', async () => {
    const orm = await makeOrm();
    const operator = new MikroOrmStateStore(orm);
    await operator.createRun(run({ id: 'r-a', namespace: 'a' }));
    await operator.createRun(run({ id: 'r-b', namespace: 'b' }));

    const em = orm.em.fork();
    const rows = await em.find(WorkflowRunEntity, {});

    expect(rows.map((r) => r.id).sort()).toEqual(['r-a', 'r-b']);
  });

  it('em.getRepository(WorkflowRunEntity) is the custom repository', async () => {
    const orm = await makeOrm();

    const repo = orm.em.fork().getRepository(WorkflowRunEntity);

    expect(repo).toBeInstanceOf(WorkflowRunRepository);
  });

  it('the repository is subject to the namespace filter, and needs no filter param', async () => {
    const orm = await makeOrm();
    const operator = new MikroOrmStateStore(orm);
    await operator.createRun(run({ id: 'r-a', namespace: 'a' }));
    await operator.createRun(run({ id: 'r-b', namespace: 'b' }));

    // Never calls setFilterParams: `args: false` on the filter is what keeps this from throwing
    // "No arguments provided for filter 'namespace'".
    const unscoped = orm.em.fork().getRepository(WorkflowRunEntity);
    expect((await unscoped.findAll()).map((r) => r.id).sort()).toEqual(['r-a', 'r-b']);

    // And the filter still bites when the consumer does scope it, so the repository is not a way
    // around the tenant read boundary.
    const scopedEm = orm.em.fork();
    scopedEm.setFilterParams('namespace', { namespace: 'a' });
    const scoped = scopedEm.getRepository(WorkflowRunEntity);
    expect((await scoped.findAll()).map((r) => r.id)).toEqual(['r-a']);
  });
});
