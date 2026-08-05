import type { WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { MikroORM } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { ENTITIES, WorkflowRunEntity } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

/**
 * `WorkflowRun.origin` — which library/module registered the workflow — persisted and queried by the
 * MikroORM adapter. The cases that matter are the ones about ABSENCE: `origin` is the one durable
 * column that must never be defaulted, because a run written before the column existed has no
 * recoverable origin and a plausible-looking stand-in would be indistinguishable from a real
 * registration in the dashboard's facet.
 */

const now = new Date('2026-06-26T00:00:00.000Z');
const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: 'x',
  workflow: 'w',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  createdAt: now,
  updatedAt: now,
  ...over,
});

async function makeStore() {
  const orm = await MikroORM.init({
    dbName: ':memory:',
    entities: [...ENTITIES],
    allowGlobalContext: true,
  });
  await orm.schema.create();
  return { store: new MikroOrmStateStore(orm), orm };
}

/**
 * Write a run row WITHOUT ever naming the origin column — a faithful stand-in for a row inserted by
 * a deploy that predates it (the `ALTER TABLE ... ADD COLUMN` leaves exactly this: NULL).
 */
async function insertRowPredatingOrigin(orm: MikroORM, id: string): Promise<void> {
  await orm.em.fork().insert(WorkflowRunEntity, {
    id,
    workflow: 'w',
    workflowVersion: '1',
    status: 'pending',
    namespace: 'default',
    createdAt: now,
    updatedAt: now,
  });
}

describe('MikroOrmStateStore origin', () => {
  it('persists origin and leaves it undefined when the run has none', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-catalog-pipeline' }));
    await store.createRun(run({ id: 'b' }));

    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
    expect((await store.getRun('b'))?.origin).toBeUndefined();
    await orm.close(true);
  });

  it('reads a row that predates the column as undefined, never a defaulted value', async () => {
    const { store, orm } = await makeStore();
    await insertRowPredatingOrigin(orm, 'old');

    const loaded = await store.getRun('old');
    expect(loaded).not.toBeNull();
    // Explicitly NOT 'default' (what `namespace` does) and not any other stand-in: unknown is unknown.
    expect(loaded?.origin).toBeUndefined();
    await orm.close(true);
  });

  it('does not lose the origin when an unrelated field is patched', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-agent' }));

    await store.updateRun('a', { status: 'completed' });

    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-agent');

    // ...and a patch that DOES name it is mapped like every other run column.
    await store.updateRun('a', { origin: '@dudousxd/nestjs-catalog-pipeline' });
    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
    await orm.close(true);
  });

  it('filters listRuns by origin, excluding other origins AND unknown-origin runs', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-catalog-pipeline' }));
    await store.createRun(run({ id: 'b', origin: '@dudousxd/nestjs-agent' }));
    await store.createRun(run({ id: 'c' })); // unknown origin
    await insertRowPredatingOrigin(orm, 'old'); // unknown origin, written before the column

    expect(
      (await store.listRuns({ origin: '@dudousxd/nestjs-catalog-pipeline' })).map((r) => r.id),
    ).toEqual(['a']);
    // An unknown origin is never folded into some bucket to make the facet look complete...
    expect(await store.listRuns({ origin: 'unknown' })).toEqual([]);
    // ...it is reachable only with the filter off, which is why "all origins" stays the default view.
    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'old']);
    await orm.close(true);
  });

  it('applies the origin filter on the raw-SQL (tag/attribute) query path too', async () => {
    const { store, orm } = await makeStore();
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-agent', tags: ['etl'] }));
    await store.createRun(
      run({ id: 'b', origin: '@dudousxd/nestjs-catalog-pipeline', tags: ['etl'] }),
    );
    await store.createRun(run({ id: 'c', tags: ['etl'] }));

    // `tag` routes listRuns through the QueryBuilder branch — a separate code path from `em.find`.
    const rows = await store.listRuns({ tag: 'etl', origin: '@dudousxd/nestjs-agent' });
    expect(rows.map((r) => r.id)).toEqual(['a']);
    await orm.close(true);
  });

  it('declares the column nullable with no default (a default would never reach old rows anyway)', async () => {
    const { orm } = await makeStore();
    const prop = orm.getMetadata().get('WorkflowRunEntity').properties.origin;

    expect(prop.fieldNames[0]).toBe('origin');
    expect(prop.nullable).toBe(true);
    // The trap this guards: a MikroORM `default` (or a TS field initialiser) applies only to rows the
    // ORM inserts from now on, so it would stamp NEW runs with a lie while every pre-existing row
    // stayed NULL — the worst of both.
    expect(prop.default).toBeUndefined();
    await orm.close(true);
  });
});
