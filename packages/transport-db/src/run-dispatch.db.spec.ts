import 'reflect-metadata';
import { runRunDispatchContract } from '@dudousxd/nestjs-durable-testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll } from 'vitest';
import { DbTransport } from './db-transport';
import { typeOrmExecutor } from './executors';

/**
 * The shared run-dispatch contract against a real Postgres (testcontainers): two DbTransports on one
 * fresh table prefix per case stand for two instances of a deployment, claiming run rows with
 * `FOR UPDATE SKIP LOCKED`. Run with `pnpm test:db`; skips when Docker is unavailable or
 * `SKIP_TESTCONTAINERS` is set.
 */

let pg: StartedPostgreSqlContainer | undefined;
let ds: DataSource | undefined;
let unavailable: string | undefined;
let cases = 0;

beforeAll(async () => {
  if (process.env.SKIP_TESTCONTAINERS) {
    unavailable = 'SKIP_TESTCONTAINERS is set';
    return;
  }
  try {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      extra: { max: 30 },
    });
    await ds.initialize();
  } catch (err) {
    unavailable = `no Postgres container: ${err instanceof Error ? err.message : String(err)}`;
  }
}, 180_000);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  await pg?.stop();
});

runRunDispatchContract('DbTransport (Postgres)', async () => {
  if (unavailable || !ds) return unavailable ?? 'no Postgres';
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
});
