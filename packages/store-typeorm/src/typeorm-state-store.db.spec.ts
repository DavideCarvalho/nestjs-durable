import {
  type StateStoreContext,
  StateStoreUnavailableError,
  runStateStoreContract,
} from '@dudousxd/nestjs-durable-testing';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { afterAll, beforeAll, describe } from 'vitest';
import { makeTypeOrmStoreFactory } from './conformance';

/**
 * Real-engine matrix for the TypeORM adapter: the SHARED cross-store contract, run against Postgres
 * and MySQL spun up via testcontainers. This is where the dialect-aware DDL (`ensureSchema`), the
 * search-attribute EXISTS pushdown, and the per-driver identifier quoting are validated against the
 * actual engines instead of SQLite. Run with `pnpm test:db`.
 *
 * Skips cleanly (each case logs once and passes) when Docker is unavailable or `SKIP_TESTCONTAINERS`
 * is set — never fails the suite for a missing daemon. One container per dialect, shared across the
 * contract's cases; the factory truncates between tests.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;
// An existing database instead of a testcontainer, like the schema-repair specs.
const externalPgUrl = process.env.DURABLE_TEST_PG_URL;
const externalMysqlUrl = process.env.DURABLE_TEST_MYSQL_URL;

/**
 * A database of this spec's own on a shared server: `<base>_typeorm`, created when missing. Every
 * store's db spec gets the same `DURABLE_TEST_*_URL`, and each defines the `durable_*` tables its own
 * way (Prisma's `wake_at` is a BIGINT, TypeORM's a DATETIME), so one database shared between specs
 * running at once lets one spec's schema clobber another's mid-run. Idempotent, and safe when two
 * specs race to create it.
 */
async function dedicatedDatabaseUrl(type: 'postgres' | 'mysql', baseUrl: string): Promise<string> {
  const target = new URL(baseUrl);
  const name = `${decodeURIComponent(target.pathname.slice(1)) || type}_typeorm`;
  const admin = new DataSource({ type, url: baseUrl });
  await admin.initialize();
  try {
    if (type === 'mysql') await admin.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
    else {
      const rows = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (rows.length === 0) {
        await admin.query(`CREATE DATABASE "${name}"`).catch((err: { code?: string }) => {
          // 42P04 duplicate_database; 23505 when a concurrent CREATE wins the catalog insert.
          if (err.code !== '42P04' && err.code !== '23505') throw err;
        });
      }
    }
  } finally {
    await admin.destroy();
  }
  target.pathname = `/${name}`;
  return target.toString();
}

// --- Postgres ---------------------------------------------------------------------------------

let pgOptions: DataSourceOptions | undefined;
let pgError: unknown;
let pg: StartedPostgreSqlContainer | undefined;

beforeAll(async () => {
  if (externalPgUrl) {
    pgOptions = { type: 'postgres', url: await dedicatedDatabaseUrl('postgres', externalPgUrl) };
    return;
  }
  if (skipped) return;
  try {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    pgOptions = {
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
    };
  } catch (err) {
    pgError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await pg?.stop();
});

describe('TypeORM (Postgres) [real engine]', () => {
  runStateStoreContract('TypeORM (Postgres)', async (): Promise<StateStoreContext> => {
    if (skipped && !externalPgUrl) throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
    if (pgError)
      throw new StateStoreUnavailableError(
        `Postgres testcontainer unavailable (is Docker running?): ${String(pgError)}`,
      );
    if (!pgOptions) throw new StateStoreUnavailableError('Postgres container not started');
    return makeTypeOrmStoreFactory(pgOptions)();
  });
});

// --- MySQL ------------------------------------------------------------------------------------

let mysqlOptions: DataSourceOptions | undefined;
let mysqlError: unknown;
let mysql: StartedMySqlContainer | undefined;

beforeAll(async () => {
  if (externalMysqlUrl) {
    mysqlOptions = { type: 'mysql', url: await dedicatedDatabaseUrl('mysql', externalMysqlUrl) };
    return;
  }
  if (skipped) return;
  try {
    mysql = await new MySqlContainer('mysql:8.0').start();
    mysqlOptions = {
      type: 'mysql',
      host: mysql.getHost(),
      port: mysql.getPort(),
      username: mysql.getUsername(),
      password: mysql.getUserPassword(),
      database: mysql.getDatabase(),
    };
  } catch (err) {
    mysqlError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await mysql?.stop();
});

describe('TypeORM (MySQL) [real engine]', () => {
  runStateStoreContract('TypeORM (MySQL)', async (): Promise<StateStoreContext> => {
    if (skipped && !externalMysqlUrl)
      throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
    if (mysqlError)
      throw new StateStoreUnavailableError(
        `MySQL testcontainer unavailable (is Docker running?): ${String(mysqlError)}`,
      );
    if (!mysqlOptions) throw new StateStoreUnavailableError('MySQL container not started');
    return makeTypeOrmStoreFactory(mysqlOptions)();
  });
});
