import 'reflect-metadata';
import { runRunDispatchContract } from '@dudousxd/nestjs-durable-testing';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { afterAll, beforeAll } from 'vitest';
import { DbTransport } from './db-transport';
import { typeOrmExecutor } from './executors';

/**
 * The shared run-dispatch contract against a real Postgres and a real MySQL (testcontainers): two
 * DbTransports on one fresh table prefix per case stand for two instances of a deployment, claiming
 * run rows with `FOR UPDATE SKIP LOCKED`. The two dialects queue a run with different upserts
 * (`ON CONFLICT DO UPDATE` / `ON DUPLICATE KEY UPDATE`). Run with `pnpm test:db`; skips when Docker
 * is unavailable or `SKIP_TESTCONTAINERS` is set.
 */

interface Backend {
  ds?: DataSource;
  unavailable?: string;
  stop?: () => Promise<unknown>;
}

const backends: Record<'postgres' | 'mysql', Backend> = { postgres: {}, mysql: {} };
let cases = 0;

async function connect(backend: Backend, options: DataSourceOptions): Promise<void> {
  const ds = new DataSource(options);
  await ds.initialize();
  backend.ds = ds;
}

beforeAll(async () => {
  if (process.env.SKIP_TESTCONTAINERS) {
    backends.postgres.unavailable = 'SKIP_TESTCONTAINERS is set';
    backends.mysql.unavailable = 'SKIP_TESTCONTAINERS is set';
    return;
  }
  const describeErr = (err: unknown) => (err instanceof Error ? err.message : String(err));
  await Promise.all([
    (async () => {
      try {
        const pg: StartedPostgreSqlContainer = await new PostgreSqlContainer(
          'postgres:16-alpine',
        ).start();
        backends.postgres.stop = () => pg.stop();
        await connect(backends.postgres, {
          type: 'postgres',
          host: pg.getHost(),
          port: pg.getPort(),
          username: pg.getUsername(),
          password: pg.getPassword(),
          database: pg.getDatabase(),
          extra: { max: 30 },
        });
      } catch (err) {
        backends.postgres.unavailable = `no Postgres container: ${describeErr(err)}`;
      }
    })(),
    (async () => {
      try {
        const mysql: StartedMySqlContainer = await new MySqlContainer('mysql:8.0').start();
        backends.mysql.stop = () => mysql.stop();
        await connect(backends.mysql, {
          type: 'mysql',
          host: mysql.getHost(),
          port: mysql.getPort(),
          username: mysql.getUsername(),
          password: mysql.getUserPassword(),
          database: mysql.getDatabase(),
          extra: { connectionLimit: 30 },
        });
      } catch (err) {
        backends.mysql.unavailable = `no MySQL container: ${describeErr(err)}`;
      }
    })(),
  ]);
}, 300_000);

afterAll(async () => {
  for (const backend of Object.values(backends)) {
    if (backend.ds?.isInitialized) await backend.ds.destroy();
    await backend.stop?.();
  }
});

for (const dialect of ['postgres', 'mysql'] as const) {
  runRunDispatchContract(
    `DbTransport (${dialect === 'postgres' ? 'Postgres' : 'MySQL'})`,
    async () => {
      const { ds, unavailable } = backends[dialect];
      if (unavailable || !ds) return unavailable ?? `no ${dialect}`;
      const executor = typeOrmExecutor(ds);
      return {
        pair: async () => {
          cases += 1;
          const prefix = `rd${cases}_${Date.now()}`;
          const make = (instanceId: string) =>
            new DbTransport({ executor, prefix, pollMs: 25, instanceId });
          return [make(`${prefix}-a`), make(`${prefix}-b`)];
        },
      };
    },
  );
}
