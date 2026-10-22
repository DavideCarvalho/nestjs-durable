import { checkpointStatsOf, queryCheckpointsOf } from '@dudousxd/nestjs-durable-core';
import {
  DURABLE_CANONICAL_COLUMNS,
  aggregationFixture,
  assertDurableColumns,
  preserveColumnExpectation,
} from '@dudousxd/nestjs-durable-testing';
import type { EntitySchema } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type DurableColumnNaming, durableEntities } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

/**
 * Cross-adapter column contract for the MikroORM store. The durable tables are adapter-agnostic, so
 * the physical columns must match {@link DURABLE_CANONICAL_COLUMNS} (canonical `snake_case`) — this is
 * the guard the project lacked when the TypeORM and MikroORM adapters silently diverged (one keeping
 * camelCase, the other defaulting to its naming strategy), breaking a store swap with a runtime
 * "Unknown column" error. Asserting the resolved `fieldNames` here turns that divergence into a
 * failing unit test.
 */

let orm: MikroORM | undefined;

afterEach(async () => {
  await orm?.close(true);
  orm = undefined;
});

/** Each durable table is backed by exactly one entity class — map them so the resolver can look up
 *  metadata by class name (robust regardless of how the ORM exposes table names). */
const TABLE_TO_CLASS: Record<string, string> = {
  durable_workflow_runs: 'WorkflowRunEntity',
  durable_step_checkpoints: 'StepCheckpointEntity',
  durable_run_attributes: 'RunAttributeEntity',
  durable_signal_waiters: 'SignalWaiterEntity',
  durable_buffered_signals: 'BufferedSignalEntity',
  durable_buffered_events: 'BufferedEventEntity',
  durable_schedules: 'ScheduleEntity',
};

/** Init an ORM with the durable entities under `naming` and return a (table, property) → column resolver. */
async function columnResolver(naming: DurableColumnNaming) {
  orm = await MikroORM.init({
    dbName: ':memory:',
    entities: durableEntities({ naming }) as unknown as EntitySchema[],
    allowGlobalContext: true,
  });
  const meta = orm.getMetadata();
  return (table: string, property: string) => {
    const className = TABLE_TO_CLASS[table];
    if (!className) return undefined;
    return meta.get(className).props.find((p) => p.name === property)?.fieldNames?.[0];
  };
}

describe('durableEntities column naming', () => {
  it('defaults to the canonical snake_case columns', async () => {
    const resolve = await columnResolver('snake_case');
    expect(assertDurableColumns(resolve)).toEqual([]);
  });

  it('uses snake_case when no naming option is given', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      entities: durableEntities() as unknown as EntitySchema[],
      allowGlobalContext: true,
    });
    const meta = orm.getMetadata().get('WorkflowRunEntity');
    const col = (prop: string) => meta.props.find((p) => p.name === prop)?.fieldNames?.[0];
    expect(col('createdAt')).toBe(DURABLE_CANONICAL_COLUMNS.durable_workflow_runs.createdAt);
    expect(col('workflowVersion')).toBe(
      DURABLE_CANONICAL_COLUMNS.durable_workflow_runs.workflowVersion,
    );
  });

  it('preserves verbatim camelCase property names under naming: "preserve"', async () => {
    const resolve = await columnResolver('preserve');
    expect(assertDurableColumns(resolve, preserveColumnExpectation())).toEqual([]);
  });

  it('accepts a custom mapping function', async () => {
    const resolve = await columnResolver((property) => `c_${property}`);
    expect(resolve('durable_workflow_runs', 'createdAt')).toBe('c_createdAt');
    expect(resolve('durable_run_attributes', 'numValue')).toBe('c_numValue');
  });

  it('aggregates and queries checkpoints through a custom column naming', async () => {
    orm = await MikroORM.init({
      dbName: ':memory:',
      entities: durableEntities({
        naming: (property) => `c_${property}`,
      }) as unknown as EntitySchema[],
      allowGlobalContext: true,
    });
    await orm.schema.create();
    const store = new MikroOrmStateStore(orm);
    const at = new Date('2026-06-11T00:00:00.000Z');
    await store.createRun({
      id: 'r1',
      workflow: 'w',
      workflowVersion: '1',
      status: 'running',
      createdAt: at,
      updatedAt: at,
    });
    for (const row of aggregationFixture()) await store.saveCheckpoint(row);
    const full = await store.listCheckpoints('r1');
    const byBucket = (a: { group: string | null; status: string; nameKind: string }) =>
      `${a.group}|${a.status}|${a.nameKind}`;
    const sorted = <T extends { group: string | null; status: string; nameKind: string }>(
      xs: T[],
    ) => [...xs].sort((a, b) => byBucket(a).localeCompare(byBucket(b)));
    expect(sorted(await store.checkpointStats('r1'))).toEqual(sorted(checkpointStatsOf(full)));
    const query = { excludeGroups: ['steps:2:120'], statuses: ['completed' as const], limit: 9 };
    expect(await store.queryCheckpoints('r1', query)).toEqual(queryCheckpointsOf(full, query));
  });
});
