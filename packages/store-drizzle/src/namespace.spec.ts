import { WorkflowEngine, type WorkflowRun } from '@dudousxd/nestjs-durable-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { DrizzleStateStore } from './drizzle-state-store';
import { durableSchema, workflowRuns } from './schema';

/**
 * `WorkflowRun.namespace` — the worker-pool partition — as the Drizzle adapter persists and enforces
 * it. This is the tenant ISOLATION boundary, not a dashboard facet: the core interface promises that
 * "a worker only picks up / recovers / resumes-timers-for / times-out runs in its own namespace", and
 * each of those four verbs is a distinct query in this adapter:
 *
 *  - picks up          → `listPendingRuns(limit, namespace)`
 *  - recovers          → `listIncompleteRuns(namespace)`
 *  - resumes timers for→ `listDueTimers(nowMs, namespace)`
 *  - times out         → `listRuns({ workflow, status, namespace })`, issued by `engine.sweepTimeouts`
 *
 * Before this adapter had the column, every one of them was unscoped and TypeScript said nothing (an
 * implementation may declare fewer parameters than its interface), so a worker serving tenant A
 * drained, recovered and cancelled tenant B's runs in silence. Each case below therefore asserts BOTH
 * halves: the tenant sees its own run, and does not see the other's.
 *
 * The adapter has no auto-schema (you own the migrations), so the pre-existing-row cases are
 * reproduced the way a real deploy hits them: a table created WITHOUT the column, a run written into
 * it, and only then the `ALTER TABLE`.
 */

const at = new Date('2026-08-05T00:00:00.000Z');
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  createdAt: at,
  updatedAt: at,
  ...over,
});

/** The runs table as it stood BEFORE this change — every column except `namespace`. */
const RUNS_DDL_BEFORE_NAMESPACE = `
CREATE TABLE durable_workflow_runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, workflow_version TEXT NOT NULL, status TEXT NOT NULL,
  input TEXT, output TEXT, error TEXT, wake_at INTEGER, locked_by TEXT, locked_until INTEGER,
  awaiting_decision_task_id TEXT,
  recovery_attempts INTEGER, tags TEXT, search_attributes TEXT, priority INTEGER, origin TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE durable_run_attributes (
  run_id TEXT NOT NULL, key TEXT NOT NULL, str_value TEXT, num_value REAL, PRIMARY KEY (run_id, key)
);
CREATE TABLE durable_step_checkpoints (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, step_id TEXT NOT NULL,
  status TEXT NOT NULL, input TEXT, output TEXT, error TEXT, events TEXT, attempts INTEGER NOT NULL,
  worker_group TEXT, parallel_group TEXT, wake_at INTEGER,
  enqueued_at INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TABLE durable_signal_waiters (token TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, parallel_group TEXT);
CREATE TABLE durable_buffered_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, payload TEXT);
CREATE TABLE durable_buffered_events (id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT, published_at INTEGER NOT NULL);
`;

/** The migration a consumer runs to adopt this change — the exact statements the schema prescribes.
 *  The DEFAULT is what backfills every pre-existing row to `'default'` as part of the ADD COLUMN. */
const ADD_NAMESPACE = `
ALTER TABLE durable_workflow_runs ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS durable_workflow_runs_namespace_status_idx
  ON durable_workflow_runs (namespace, status, created_at);
`;

/** The migration a consumer runs if they mirror `origin`'s bare form instead — no default, so
 *  pre-existing rows stay NULL. Supported, but not what the schema tells them to run. */
const ADD_NAMESPACE_NULLABLE = 'ALTER TABLE durable_workflow_runs ADD COLUMN namespace TEXT;';

function makeStore(ddl = `${RUNS_DDL_BEFORE_NAMESPACE}${ADD_NAMESPACE}`) {
  const sqlite = new Database(':memory:');
  sqlite.exec(ddl);
  return { store: new DrizzleStateStore(drizzle(sqlite, { schema: durableSchema })), sqlite };
}

describe('DrizzleStateStore namespace', () => {
  // The schema is the migration contract: consumers generate their DDL from it (or copy the
  // statements out of its docblock), so a silently nullable/defaultless column here would hand
  // pre-existing rows a NULL namespace no worker asks for.
  it("declares the column NOT NULL DEFAULT 'default' and the poll-path index", () => {
    const config = getTableConfig(workflowRuns);
    const column = config.columns.find((c) => c.name === 'namespace');
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe('default');
    expect(
      config.indexes.map((i) => ({ name: i.config.name, on: i.config.columns.map((c) => c.name) })),
    ).toContainEqual({
      name: 'durable_workflow_runs_namespace_status_idx',
      on: ['namespace', 'status', 'created_at'],
    });
  });

  it('persists the namespace, defaulting a run that names none to "default"', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));
    await store.createRun(run({ id: 'c' })); // created by an unscoped engine

    expect((await store.getRun('a'))?.namespace).toBe('alpha');
    expect((await store.getRun('c'))?.namespace).toBe('default');
    sqlite.close();
  });

  // THE central isolation case: two tenants' runs in one table, a worker asking for one of them.
  it('does not let a worker pick up another namespace pending run', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));
    await store.createRun(run({ id: 'b', namespace: 'beta' }));

    expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listPendingRuns(10, 'beta')).map((r) => r.id)).toEqual(['b']);
    // ...and the foreign run does not even consume the FIFO budget.
    expect((await store.listPendingRuns(1, 'beta')).map((r) => r.id)).toEqual(['b']);
    sqlite.close();
  });

  it('does not let a worker recover another namespace crashed run', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha', status: 'running' }));
    await store.createRun(run({ id: 'b', namespace: 'beta', status: 'running' }));
    await store.createRun(run({ id: 'c', namespace: 'beta', status: 'cancelling' }));

    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listIncompleteRuns('beta')).map((r) => r.id).sort()).toEqual(['b', 'c']);
    sqlite.close();
  });

  it('does not let a worker resume another namespace due timer', async () => {
    const { store, sqlite } = makeStore();
    const due = { status: 'suspended' as const, wakeAt: at.getTime() - 1 };
    await store.createRun(run({ id: 'a', namespace: 'alpha', ...due }));
    await store.createRun(run({ id: 'b', namespace: 'beta', ...due }));

    expect((await store.listDueTimers(at.getTime(), 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listDueTimers(at.getTime(), 'beta')).map((r) => r.id)).toEqual(['b']);
    sqlite.close();
  });

  it('does not let a worker time out another namespace run (the listRuns sweep path)', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha', status: 'running' }));
    await store.createRun(run({ id: 'b', namespace: 'beta', status: 'running' }));

    // Exactly the query `engine.sweepTimeouts` issues per registered workflow.
    const swept = await store.listRuns({
      workflow: 'checkout',
      status: 'running',
      namespace: 'alpha',
    });
    expect(swept.map((r) => r.id)).toEqual(['a']);
    sqlite.close();
  });

  it('treats an undefined namespace as no restriction — the operator sees every tenant', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));
    await store.createRun(run({ id: 'b', namespace: 'beta' }));
    await store.createRun(run({ id: 'c' })); // 'default'
    await store.createRun(run({ id: 'r', namespace: 'beta', status: 'running' }));
    await store.createRun(
      run({ id: 't', namespace: 'beta', status: 'suspended', wakeAt: at.getTime() - 1 }),
    );

    // Not "namespace IS NULL" — an operator/control plane spans all tenants, on every path.
    expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['r']);
    expect((await store.listDueTimers(at.getTime())).map((r) => r.id)).toEqual(['t']);
    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'r', 't']);
    sqlite.close();
  });

  it('keeps a run in its namespace when an unrelated field is patched, and moves it when named', async () => {
    const { store, sqlite } = makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));

    await store.updateRun('a', { status: 'running' });
    expect((await store.getRun('a'))?.namespace).toBe('alpha');
    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['a']);

    await store.updateRun('a', { namespace: 'beta' });
    expect((await store.getRun('a'))?.namespace).toBe('beta');
    // A patch naming it as undefined means the default namespace, never "no tenant".
    await store.updateRun('a', { namespace: undefined });
    expect((await store.getRun('a'))?.namespace).toBe('default');
    sqlite.close();
  });

  it('gives a row written before the column existed the default namespace, so it stays reachable', async () => {
    // Table without the column; a run lands in it; only then does the prescribed migration run.
    const sqlite = new Database(':memory:');
    sqlite.exec(RUNS_DDL_BEFORE_NAMESPACE);
    sqlite
      .prepare(
        `INSERT INTO durable_workflow_runs
          (id, workflow, workflow_version, status, created_at, updated_at)
          VALUES ('old', 'checkout', '1', 'pending', ?, ?)`,
      )
      .run(at.getTime(), at.getTime());
    sqlite.exec(ADD_NAMESPACE);
    const store = new DrizzleStateStore(drizzle(sqlite, { schema: durableSchema }));

    // The ADD COLUMN's DEFAULT backfilled it: the run really did execute unscoped, so 'default' is a
    // fact about it, and the default worker still picks it up instead of losing it forever.
    expect((await store.getRun('old'))?.namespace).toBe('default');
    expect((await store.listPendingRuns(10, 'default')).map((r) => r.id)).toEqual(['old']);
    expect(await store.listPendingRuns(10, 'alpha')).toEqual([]);
    sqlite.close();
  });

  it('still reaches a pre-existing row left NULL by a bare ADD COLUMN, without leaking it to a tenant', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(RUNS_DDL_BEFORE_NAMESPACE);
    sqlite
      .prepare(
        `INSERT INTO durable_workflow_runs
          (id, workflow, workflow_version, status, created_at, updated_at)
          VALUES ('old', 'checkout', '1', 'pending', ?, ?)`,
      )
      .run(at.getTime(), at.getTime());
    sqlite.exec(ADD_NAMESPACE_NULLABLE); // no DEFAULT → the row's namespace is SQL NULL
    const store = new DrizzleStateStore(drizzle(sqlite, { schema: durableSchema }));

    // A NULL row and a worker asking for 'default' must not silently miss each other...
    expect((await store.listPendingRuns(10, 'default')).map((r) => r.id)).toEqual(['old']);
    expect((await store.getRun('old'))?.namespace).toBe('default');
    // ...and it is still not another tenant's to take.
    expect(await store.listPendingRuns(10, 'alpha')).toEqual([]);
    expect(await store.listRuns({ namespace: 'alpha' })).toEqual([]);
    sqlite.close();
  });

  it('a namespaced engine does not time out another namespace run end-to-end', async () => {
    const { store, sqlite } = makeStore();
    const engine = new WorkflowEngine({ store, namespace: 'alpha' });
    engine.register('slow', '1', async () => undefined, { executionTimeout: '1h' });

    const old = new Date(1000);
    for (const [id, namespace] of [
      ['mine', 'alpha'],
      ['theirs', 'beta'],
    ]) {
      await store.createRun({
        id,
        workflow: 'slow',
        workflowVersion: '1',
        status: 'suspended',
        input: {},
        namespace,
        createdAt: old,
        updatedAt: old,
      });
    }

    await engine.sweepTimeouts(1000 + 3_700_000); // well past the 1h deadline for both runs

    expect((await store.getRun('mine'))?.status).toBe('cancelled');
    expect((await store.getRun('theirs'))?.status).toBe('suspended'); // another tenant's to cancel
    sqlite.close();
  });
});
