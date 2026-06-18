import 'reflect-metadata';
import {
  InMemoryStateStore,
  type RemoteStepDef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DbTransport } from './db-transport';
import { typeOrmExecutor } from './executors';

/**
 * Real-engine matrix for the SQL transport: a Postgres container spun up via testcontainers, so the
 * DBOS-style row-as-queue round-trip — which needs real `FOR UPDATE SKIP LOCKED` (unavailable on
 * SQLite) — and the failed-result path run against an actual engine instead of self-skipping. Run
 * with `pnpm test:db`.
 *
 * Postgres (not MySQL) to reuse the stores' container image; the transport's DDL + claim SQL are
 * dialect-aware (the executor reports `postgres`, so quoting is double-quotes and placeholders are
 * `$n`). Skips cleanly when Docker is unavailable or `SKIP_TESTCONTAINERS` is set.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;

let pg: StartedPostgreSqlContainer | undefined;
let pgError: unknown;
let ds: DataSource | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
    });
    await ds.initialize();
  } catch (err) {
    pgError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  await pg?.stop();
});

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

/** A durable ctx.call suspends; poll the store until the DB round-trip resumes it to a terminal state. */
async function settle(store: InMemoryStateStore, runId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended')
      return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

async function dropTables(prefix: string) {
  if (!ds) return;
  await ds.query(`DROP TABLE IF EXISTS "${prefix}_transport_tasks"`);
  await ds.query(`DROP TABLE IF EXISTS "${prefix}_transport_results"`);
}

/** Resolve the live DataSource or self-skip the case when Docker isn't available. */
function liveDataSource(ctx: { skip: () => void }): DataSource {
  if (skipped || pgError || !ds?.isInitialized) {
    ctx.skip();
    throw new Error('unreachable'); // ctx.skip() aborts; keeps the type non-undefined
  }
  return ds;
}

describe('DbTransport (real Postgres) [testcontainers]', () => {
  it('dispatches a remote step through the DB and returns the checkpointed result', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durtest${Date.now()}`;
    const transport = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: 'payments',
      prefix,
      pollMs: 50,
    });
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.call(chargeCard, { amount: 7 });
      return charge.chargeId;
    });

    await engine.start('checkout', {}, `run-${prefix}`);
    const result = await settle(store, `run-${prefix}`);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_7');

    await transport.close();
    await dropTables(prefix);
  }, 30_000);

  it('reports a failed result when the worker handler throws', async (ctx) => {
    const ds = liveDataSource(ctx);
    const prefix = `durtestf${Date.now()}`;
    const transport = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: 'payments',
      prefix,
      pollMs: 50,
    });
    transport.handle('payments.charge-card', async () => {
      throw new Error('declined');
    });

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => c.call(chargeCard, { amount: 1 }));

    await engine.start('checkout', {}, `run-${prefix}`);
    const result = await settle(store, `run-${prefix}`);
    expect(result.status).toBe('failed');

    await transport.close();
    await dropTables(prefix);
  }, 30_000);
});
