import type { WorkflowRun } from '@dudousxd/nestjs-durable-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DrizzleStateStore } from './drizzle-state-store';
import { durableSchema } from './schema';

/**
 * `WorkflowRun.origin` — which library/module registered the workflow — persisted and queried by the
 * Drizzle adapter. The cases that matter are the ones about ABSENCE: `origin` is the one durable
 * column that must never be defaulted, because a run written before the column existed has no
 * recoverable origin and a plausible-looking stand-in would be indistinguishable from a real
 * registration in the dashboard's facet.
 *
 * This adapter has no auto-schema (you own the migrations), so the "pre-existing row" case is
 * reproduced the way a real deploy hits it: the table is created WITHOUT `origin`, a run is written,
 * then the migration (`ALTER TABLE ... ADD COLUMN origin TEXT`) runs and leaves that row NULL.
 */

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

/** The runs table as it stood BEFORE this change — every column except `origin`. */
const RUNS_DDL_BEFORE_ORIGIN = `
CREATE TABLE durable_workflow_runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, workflow_version TEXT NOT NULL, status TEXT NOT NULL,
  input TEXT, output TEXT, error TEXT, wake_at INTEGER, locked_by TEXT, locked_until INTEGER,
  awaiting_decision_task_id TEXT,
  recovery_attempts INTEGER, tags TEXT, search_attributes TEXT, priority INTEGER,
  namespace TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE durable_run_attributes (
  run_id TEXT NOT NULL, key TEXT NOT NULL, str_value TEXT, num_value REAL, PRIMARY KEY (run_id, key)
);
`;
/** The migration a consumer runs to adopt this change. */
const ADD_ORIGIN = 'ALTER TABLE durable_workflow_runs ADD COLUMN origin TEXT;';

function makeStore(ddl = `${RUNS_DDL_BEFORE_ORIGIN}${ADD_ORIGIN}`) {
  const sqlite = new Database(':memory:');
  sqlite.exec(ddl);
  return { store: new DrizzleStateStore(drizzle(sqlite, { schema: durableSchema })), sqlite };
}

describe('DrizzleStateStore origin', () => {
  it('persists origin and leaves it undefined when the run has none', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-catalog-pipeline' }));
    await store.createRun(run({ id: 'b' }));

    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
    expect((await store.getRun('b'))?.origin).toBeUndefined();
    sqlite.close();
  });

  it('does not lose the origin when an unrelated field is patched', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-agent' }));

    await store.updateRun('a', { status: 'completed' });

    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-agent');

    // ...and a patch that DOES name it is mapped like every other run column.
    await store.updateRun('a', { origin: '@dudousxd/nestjs-catalog-pipeline' });
    expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
    sqlite.close();
  });

  it('reads a row written before the migration as undefined, never a defaulted value', async () => {
    // Table without the column; a run lands in it; only then does the migration add the column.
    const sqlite = new Database(':memory:');
    sqlite.exec(RUNS_DDL_BEFORE_ORIGIN);
    sqlite
      .prepare(
        `INSERT INTO durable_workflow_runs
          (id, workflow, workflow_version, status, created_at, updated_at)
          VALUES ('old', 'checkout', '1', 'running', ?, ?)`,
      )
      .run(at.getTime(), at.getTime());
    sqlite.exec(ADD_ORIGIN);
    const store = new DrizzleStateStore(drizzle(sqlite, { schema: durableSchema }));

    expect((await store.getRun('old'))?.origin).toBeUndefined();
    sqlite.close();
  });

  it('filters listRuns by origin, excluding other origins AND unknown-origin runs', async () => {
    const { store, sqlite } = makeStore();
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
    sqlite.close();
  });
});
