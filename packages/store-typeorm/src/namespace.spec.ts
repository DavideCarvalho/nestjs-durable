import type { WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { TypeOrmStateStore } from './typeorm-state-store';

/**
 * `WorkflowRun.namespace` — the worker-pool partition — as the TypeORM adapter persists and filters
 * it. This is the tenant isolation boundary the core interface documents: a worker only picks up
 * (`listPendingRuns`), recovers (`listIncompleteRuns`), resumes timers for (`listDueTimers`) and
 * times out (`listRuns`, how the engine's timeout sweep finds in-flight runs) runs in its OWN
 * namespace. So every case here asserts the negative too — the run in the OTHER namespace must not
 * come back — because an assertion that only checks "my run is in the result" passes just as well
 * when no predicate is applied at all.
 */

const now = new Date('2026-06-26T00:00:00.000Z');
/** How the better-sqlite3 driver writes a `datetime` column, for the raw legacy-row INSERT below. */
const LEGACY_TIMESTAMP = '2026-06-26 00:00:00.000';
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'x',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  createdAt: now,
  updatedAt: now,
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

async function makeStore() {
  const dataSource = await makeDataSource(true);
  return { store: new TypeOrmStateStore(dataSource), dataSource };
}

describe('TypeOrmStateStore namespace', () => {
  it('persists the namespace, defaulting a run that has none to "default"', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));
    await store.createRun(run({ id: 'c' })); // no namespace -> the unscoped partition

    expect((await store.getRun('a'))?.namespace).toBe('alpha');
    expect((await store.getRun('c'))?.namespace).toBe('default');
    await dataSource.destroy();
  });

  it('does not hand tenant B’s pending runs to tenant A’s worker', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));
    await store.createRun(run({ id: 'b', namespace: 'beta' }));

    expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listPendingRuns(10, 'beta')).map((r) => r.id)).toEqual(['b']);
    // `undefined` is NOT "namespace is undefined" — it is no restriction at all, the operator view.
    expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a', 'b']);
    // ...and a namespace nobody runs in sees nothing, rather than everything.
    expect(await store.listPendingRuns(10, 'gamma')).toEqual([]);
    await dataSource.destroy();
  });

  it('recovers and resumes timers only within the asking namespace', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'r', status: 'running', namespace: 'alpha' }));
    await store.createRun(run({ id: 's', status: 'running', namespace: 'beta' }));
    await store.createRun(
      run({ id: 't', status: 'suspended', namespace: 'alpha', wakeAt: now.getTime() - 1 }),
    );
    await store.createRun(
      run({ id: 'u', status: 'suspended', namespace: 'beta', wakeAt: now.getTime() - 1 }),
    );

    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['r']);
    expect((await store.listDueTimers(now.getTime(), 'alpha')).map((r) => r.id)).toEqual(['t']);
    // Unscoped: the control plane recovers/resumes across every tenant.
    expect((await store.listIncompleteRuns()).map((r) => r.id).sort()).toEqual(['r', 's']);
    expect((await store.listDueTimers(now.getTime())).map((r) => r.id).sort()).toEqual(['t', 'u']);
    await dataSource.destroy();
  });

  it('scopes listRuns — the path the execution-timeout sweep uses to find in-flight runs', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'a', status: 'running', namespace: 'alpha' }));
    await store.createRun(run({ id: 'b', status: 'running', namespace: 'beta' }));

    // Exactly the query `engine.sweepTimeouts` issues: workflow + status + its own namespace. If the
    // predicate were dropped, tenant alpha's sweep would cancel tenant beta's run `b`.
    expect(
      (await store.listRuns({ workflow: 'checkout', status: 'running', namespace: 'alpha' })).map(
        (r) => r.id,
      ),
    ).toEqual(['a']);
    expect((await store.listRuns({ namespace: 'beta' })).map((r) => r.id)).toEqual(['b']);
    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'b']);
    await dataSource.destroy();
  });

  it('keeps the namespace through an unrelated patch, and never writes NULL', async () => {
    const { store, dataSource } = await makeStore();
    await store.createRun(run({ id: 'a', namespace: 'alpha' }));

    await store.updateRun('a', { status: 'running' });
    expect((await store.getRun('a'))?.namespace).toBe('alpha');

    await store.updateRun('a', { namespace: 'beta' });
    expect((await store.getRun('a'))?.namespace).toBe('beta');
    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual([]);
    expect((await store.listIncompleteRuns('beta')).map((r) => r.id)).toEqual(['a']);

    // Clearing it lands on the unscoped partition, not on a NULL that no worker could match.
    await store.updateRun('a', { namespace: undefined });
    expect((await store.getRun('a'))?.namespace).toBe('default');
    expect((await store.listIncompleteRuns('default')).map((r) => r.id)).toEqual(['a']);
    await dataSource.destroy();
  });

  it('writes "default" itself when the column has no DDL default to fall back on', async () => {
    // A deployment that added the column by hand (nullable, no default) instead of letting
    // `ensureSchema` do it. The store must still write a value: a NULL row and a worker asking for
    // `'default'` would silently miss each other, and the run would never be picked up again.
    const dataSource = await makeDataSource(false);
    await dataSource.query(
      `CREATE TABLE "durable_workflow_runs" (
        "id" varchar(191) PRIMARY KEY, "workflow" varchar(191) NOT NULL,
        "workflow_version" varchar(191) NOT NULL, "status" varchar(191) NOT NULL,
        "input" text, "output" text, "error" text,
        "wake_at" datetime, "locked_by" varchar(191), "locked_until" datetime,
        "awaiting_decision_task_id" varchar(191), "recovery_attempts" integer,
        "tags" text, "search_attributes" text, "priority" integer,
        "namespace" varchar(191), "origin" varchar(191),
        "created_at" datetime NOT NULL, "updated_at" datetime NOT NULL
      )`,
    );
    const store = new TypeOrmStateStore(dataSource);
    // Creates the sibling tables; the runs table already HAS a `namespace` column, so the additive
    // heal leaves it exactly as the operator made it — nullable, with no default to lean on.
    await store.ensureSchema();

    await store.createRun(run({ id: 'n' })); // no namespace on the run

    const [row] = (await dataSource.query(
      `SELECT "namespace" AS ns FROM "durable_workflow_runs" WHERE "id" = 'n'`,
    )) as Array<{ ns: string | null }>;
    expect(row?.ns).toBe('default'); // the VALUE in the column, not what the read path coerces
    expect((await store.listPendingRuns(10, 'default')).map((r) => r.id)).toEqual(['n']);
    await dataSource.destroy();
  });

  it('self-heals a runs table that predates the namespace column, back-filling "default"', async () => {
    const dataSource = await makeDataSource(false);
    // Simulate an older deploy: the runs table exists, with every column EXCEPT `namespace`.
    await dataSource.query(
      `CREATE TABLE "durable_workflow_runs" (
        "id" varchar(191) PRIMARY KEY, "workflow" varchar(191) NOT NULL,
        "workflow_version" varchar(191) NOT NULL, "status" varchar(191) NOT NULL,
        "input" text, "output" text, "error" text,
        "wake_at" datetime, "locked_by" varchar(191), "locked_until" datetime,
        "awaiting_decision_task_id" varchar(191), "recovery_attempts" integer,
        "tags" text, "search_attributes" text, "priority" integer, "origin" varchar(191),
        "created_at" datetime NOT NULL, "updated_at" datetime NOT NULL
      )`,
    );
    // A pending run written by that older deploy, through SQL that never heard of `namespace`.
    await dataSource.query(
      `INSERT INTO "durable_workflow_runs"
        ("id", "workflow", "workflow_version", "status", "created_at", "updated_at")
        VALUES ('old', 'checkout', '1', 'pending', ?, ?)`,
      [LEGACY_TIMESTAMP, LEGACY_TIMESTAMP],
    );
    const store = new TypeOrmStateStore(dataSource);

    await store.ensureSchema(); // adds the missing `namespace` column, additively

    // The pre-existing row is NOT left NULL: it really did run in the unscoped partition, and a NULL
    // would match no equality predicate, so the run would be invisible to every worker forever.
    expect((await store.getRun('old'))?.namespace).toBe('default');
    expect((await store.listPendingRuns(10, 'default')).map((r) => r.id)).toEqual(['old']);
    // ...and it is still not visible to a worker serving some other tenant.
    expect(await store.listPendingRuns(10, 'alpha')).toEqual([]);

    // The hot-path index lands on that already-existing table too — the poll predicate is
    // (namespace, status), and every tick would otherwise scan every tenant's rows.
    const indexes = (await dataSource.query(
      `PRAGMA index_list("durable_workflow_runs")`,
    )) as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('durable_runs_namespace_status_idx');
    await dataSource.destroy();
  });
});
