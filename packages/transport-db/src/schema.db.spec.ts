import 'reflect-metadata';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbTransport } from './db-transport';
import { typeOrmExecutor } from './executors';

/**
 * `schema`: the transport tables in a schema of their own (a Postgres schema, a MySQL database)
 * while the connection's default stays `public` / the connection's database. Every statement must
 * name the schema, so nothing may land in the default one. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;
const STEP = 'payments.charge-card';

type Dialect = 'postgres' | 'mysql';
const sources: Partial<Record<Dialect, DataSource>> = {};
const errors: Partial<Record<Dialect, unknown>> = {};
let pg: StartedPostgreSqlContainer | undefined;
let mysql: StartedMySqlContainer | undefined;

beforeAll(async () => {
  try {
    const url = process.env.DURABLE_TEST_PG_URL;
    if (url) sources.postgres = new DataSource({ type: 'postgres', url });
    else if (!skipped) {
      pg = await new PostgreSqlContainer('postgres:16-alpine').start();
      sources.postgres = new DataSource({ type: 'postgres', url: pg.getConnectionUri() });
    }
    await sources.postgres?.initialize();
  } catch (err) {
    errors.postgres = err;
  }
  try {
    const url = process.env.DURABLE_TEST_MYSQL_URL;
    if (url) sources.mysql = new DataSource({ type: 'mysql', url });
    else if (!skipped) {
      mysql = await new MySqlContainer('mysql:8.0').withRootPassword('durable').start();
      sources.mysql = new DataSource({
        type: 'mysql',
        host: mysql.getHost(),
        port: mysql.getPort(),
        username: 'root',
        password: 'durable',
        database: mysql.getDatabase(),
      });
    }
    await sources.mysql?.initialize();
  } catch (err) {
    errors.mysql = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  for (const ds of Object.values(sources)) if (ds?.isInitialized) await ds.destroy();
  await pg?.stop();
  await mysql?.stop();
});

function live(dialect: Dialect, ctx: { skip: () => void }): DataSource {
  const ds = sources[dialect];
  if (errors[dialect] || !ds?.isInitialized) {
    ctx.skip();
    throw new Error('unreachable');
  }
  return ds;
}

async function settle(store: InMemoryStateStore, runId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && !['pending', 'running', 'suspended'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

/** `schema` → the transport tables found in it. */
async function tablesIn(ds: DataSource, dialect: Dialect, schema: string, prefix: string) {
  const rows: Array<{ name?: string; NAME?: string }> = await ds.query(
    dialect === 'postgres'
      ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE $2'
      : 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE ?',
    [schema, `${prefix}\\_transport\\_%`],
  );
  return rows.map((r) => r.name ?? r.NAME).sort();
}

describe.each(['postgres', 'mysql'] as const)('DbTransport schema option (%s)', (dialect) => {
  it('keeps every table in the configured schema and runs a step through it', async (ctx) => {
    const ds = live(dialect, ctx);
    const stamp = Date.now();
    const schema = `durable_tx_${stamp}`;
    const prefix = `dursch${stamp}`;
    const defaultSchema: string =
      dialect === 'postgres'
        ? 'public'
        : ((await ds.query('SELECT DATABASE() AS db'))[0] as { db: string }).db;
    const transport = new DbTransport({
      executor: typeOrmExecutor(ds),
      group: STEP,
      prefix,
      schema,
      pollMs: 20,
    });
    transport.handle(STEP, async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.step<{ chargeId: string }>(STEP, { amount: 3 });
      return charge.chargeId;
    });
    try {
      await engine.start('checkout', {}, `run-${prefix}`);
      const run = await settle(store, `run-${prefix}`);
      expect(run.status).toBe('completed');
      expect(run.output).toBe('ch_3');
      // A dispatched run goes through the runs table too.
      await transport.dispatchRuns([{ runId: `queued-${prefix}` }]);

      expect(await tablesIn(ds, dialect, schema, prefix)).toEqual([
        `${prefix}_transport_results`,
        `${prefix}_transport_runs`,
        `${prefix}_transport_tasks`,
      ]);
      expect(await tablesIn(ds, dialect, defaultSchema, prefix)).toEqual([]);
    } finally {
      await transport.close();
      const q = (id: string) => ds.driver.escape(id);
      await ds.query(
        dialect === 'postgres' ? `DROP SCHEMA ${q(schema)} CASCADE` : `DROP DATABASE ${q(schema)}`,
      );
    }
  }, 30_000);
});

describe('DbTransport schema option (validation)', () => {
  it('rejects a schema that is not a plain identifier', () => {
    const executor = {
      dialect: 'postgres' as const,
      escapeId: (id: string) => `"${id}"`,
      query: async () => [],
      transaction: async () => undefined as never,
    };
    expect(() => new DbTransport({ executor, schema: 'bad"name' })).toThrow(/invalid schema/);
    expect(() => new DbTransport({ executor, schema: 'x'.repeat(64) })).toThrow(/invalid schema/);
  });
});
