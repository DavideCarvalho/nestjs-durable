import type { WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { TypeOrmStateStore } from './typeorm-state-store';

/**
 * `WorkflowRun.origin` — which library/module registered the workflow — persisted and queried by the
 * TypeORM adapter. The cases that matter are the ones about ABSENCE: `origin` is the one durable
 * column that must never be defaulted, because a run written before the column existed has no
 * recoverable origin and a plausible-looking stand-in would be indistinguishable from a real
 * registration in the dashboard's facet.
 */

const at = new Date('2026-06-11T00:00:00.000Z');
/** How the better-sqlite3 driver writes a `datetime` column, for the raw legacy-row INSERT below. */
const LEGACY_TIMESTAMP = '2026-06-11 00:00:00.000';
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

async function makeDataSource(synchronize: boolean) {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [...ENTITIES],
    synchronize,
  });
  await dataSource.initialize();
  return dataSource;
}

describe('TypeOrmStateStore origin', () => {
  it('persists origin and leaves it undefined when the run has none', async () => {
    const dataSource = await makeDataSource(true);
    const store = new TypeOrmStateStore(dataSource);
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-catalog-pipeline' }));
    await store.createRun(run({ id: 'b' }));

    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
    expect((await store.getRun('b'))?.origin).toBeUndefined();
    await dataSource.destroy();
  });

  it('does not lose the origin when an unrelated field is patched', async () => {
    const dataSource = await makeDataSource(true);
    const store = new TypeOrmStateStore(dataSource);
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-agent' }));

    await store.updateRun('a', { status: 'completed' });

    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-agent');

    // ...and a patch that DOES name it is mapped like every other run column.
    await store.updateRun('a', { origin: '@dudousxd/nestjs-catalog-pipeline' });
    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
    await dataSource.destroy();
  });

  it('filters listRuns by origin, excluding other origins AND unknown-origin runs', async () => {
    const dataSource = await makeDataSource(true);
    const store = new TypeOrmStateStore(dataSource);
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-catalog-pipeline' }));
    await store.createRun(run({ id: 'b', origin: '@dudousxd/nestjs-agent' }));
    await store.createRun(run({ id: 'c' })); // unknown origin

    expect(
      (await store.listRuns({ origin: '@dudousxd/nestjs-catalog-pipeline' })).map((r) => r.id),
    ).toEqual(['a']);
    // An unknown origin is never folded into some bucket to make the facet look complete...
    expect(await store.listRuns({ origin: 'unknown' })).toEqual([]);
    // ...it is reachable only with the filter off, which is why "all origins" stays the default view.
    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    await dataSource.destroy();
  });

  it('self-heals a pre-existing runs table that predates the origin column', async () => {
    const dataSource = await makeDataSource(false);
    // Simulate an older deploy: the runs table exists, with every column EXCEPT `origin`.
    await dataSource.query(
      `CREATE TABLE "durable_workflow_runs" (
        "id" varchar(191) PRIMARY KEY, "workflow" varchar(191) NOT NULL,
        "workflow_version" varchar(191) NOT NULL, "status" varchar(191) NOT NULL,
        "input" text, "output" text, "error" text,
        "wake_at" datetime, "locked_by" varchar(191), "locked_until" datetime,
        "awaiting_decision_task_id" varchar(191), "recovery_attempts" integer,
        "tags" text, "search_attributes" text, "priority" integer,
        "created_at" datetime NOT NULL, "updated_at" datetime NOT NULL
      )`,
    );
    // A run written by that older deploy, through SQL that never heard of `origin`. The timestamps
    // are bound as the driver's own datetime text format (better-sqlite3 cannot bind a `Date`).
    await dataSource.query(
      `INSERT INTO "durable_workflow_runs"
        ("id", "workflow", "workflow_version", "status", "created_at", "updated_at")
        VALUES ('old', 'checkout', '1', 'running', ?, ?)`,
      [LEGACY_TIMESTAMP, LEGACY_TIMESTAMP],
    );
    const store = new TypeOrmStateStore(dataSource);

    await store.ensureSchema(); // adds the missing `origin` column, additively

    // The back-filled column is NULL for that row, and NULL reads as "unknown" — not as a value.
    expect((await store.getRun('old'))?.origin).toBeUndefined();
    // ...and the filter therefore leaves it out rather than guessing which library produced it.
    await store.createRun(run({ id: 'new', origin: '@dudousxd/nestjs-agent' }));
    expect((await store.listRuns({ origin: '@dudousxd/nestjs-agent' })).map((r) => r.id)).toEqual([
      'new',
    ]);
    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['new', 'old']);
    await dataSource.destroy();
  });
});
