import { setImmediate } from 'node:timers/promises';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DrizzlePgStateStore } from './drizzle-pg-state-store';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let admin: pg.Pool;
let store: DrizzlePgStateStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool = new pg.Pool({
    connectionString: container.getConnectionUri(),
    options: '-c lock_timeout=100ms',
  });
  store = new DrizzlePgStateStore(drizzle(pool));
  await store.ensureSchema();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await container?.stop();
});

async function withTableLock(table: string, work: () => Promise<void>): Promise<void> {
  const blocker = await admin.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    await work();
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
}

describe.skipIf(!!process.env.SKIP_TESTCONTAINERS)('engine PostgreSQL store failures', () => {
  it('contains a real checkpoint lock timeout while preserving runOne rejection and drain', async () => {
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('job', '1', async () => 'done');
    await engine.start('job', {}, 'checkpoint-lock-timeout');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await withTableLock('durable_step_checkpoints', async () => {
        await expect(engine.runOne('checkpoint-lock-timeout')).rejects.toMatchObject({
          cause: { code: '55P03' },
        });
        await expect(engine.drain()).resolves.toBeUndefined();
        await setImmediate();
        expect(unhandled).not.toHaveBeenCalled();
        expect((engine as unknown as { inflight: Set<unknown> }).inflight.size).toBe(0);
      });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects waitForRun with a real lookup lock timeout instead of leaving an unhandled promise', async () => {
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await withTableLock('durable_workflow_runs', async () => {
        await expect(
          engine.waitForRun('lookup-lock-timeout', { timeoutMs: 1000, until: 'terminal' }),
        ).rejects.toMatchObject({ cause: { code: '55P03' } });
        await setImmediate();
        expect(unhandled).not.toHaveBeenCalled();
      });
    } finally {
      process.off('unhandledRejection', unhandled);
      await engine.drain();
    }
  });
});
