import type { WorkflowRun } from '@dudousxd/nestjs-durable-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzlePgStateStore } from './drizzle-pg-state-store';

/**
 * Singleton admission under real concurrency: competing claims must never lock a workflow's active
 * runs in opposite orders. A claim Postgres kills with 40P01 leaves its run leased and idle until the
 * lease lapses, so one key's backlog drains at the lease's pace instead of the workflow's.
 */

const skipped = !process.env.DURABLE_TEST_PG_URL && !!process.env.SKIP_TESTCONTAINERS;
let container: StartedPostgreSqlContainer | undefined;
let pool: pg.Pool | undefined;
let store: DrizzlePgStateStore;

beforeAll(async () => {
  if (skipped) return;
  const url =
    process.env.DURABLE_TEST_PG_URL ??
    (await (container = await new PostgreSqlContainer('postgres:16-alpine').start()).getConnectionUri());
  pool = new pg.Pool({ connectionString: url, max: 20 });
  store = new DrizzlePgStateStore(drizzle(pool));
  await store.ensureSchema();
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool?.query('TRUNCATE durable_workflow_runs CASCADE');
});

const run = (id: string, tag: string, i: number): WorkflowRun => ({
  id,
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'running',
  input: {},
  attempts: 0,
  namespace: 'default',
  tags: [tag],
  createdAt: new Date(1_000 + i),
  updatedAt: new Date(1_000 + i),
});

describe.skipIf(skipped)('singleton admission locking [real engine]', () => {
  it('concurrent claims on one key never deadlock, across many active runs', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `r-${String(i).padStart(3, '0')}`);
    for (const [i, id] of ids.entries()) await store.createRun(run(id, 'singleton:k', i));
    const failures: unknown[] = [];
    // Each round claims every run at once, in shuffled order, so transactions overlap and rows move.
    for (let round = 0; round < 4 && failures.length === 0; round++) {
      const order = [...ids].sort(() => Math.random() - 0.5);
      await Promise.all(
        order.map((id) =>
          store
            .tryAdmitSingleton(id, 'singleton:k', 'checkout', 1, Date.now() + 1_000)
            .catch((err) => failures.push(err)),
        ),
      );
    }
    const codes = failures.map((err) => {
      const e = err as { code?: string; cause?: { code?: string } };
      return e.cause?.code ?? e.code;
    });
    expect(codes).toEqual([]);
    const active = await store.listRuns({ workflow: 'checkout', tag: 'singleton:k' });
    expect(active.filter((r) => r.tags?.includes('durable:singleton:admitted'))).toHaveLength(1);
  });
});
