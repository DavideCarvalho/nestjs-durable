import {
  type StateStoreContext,
  StateStoreUnavailableError,
  runStateStoreContract,
} from '@dudousxd/nestjs-durable-testing';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTypeOrmStoreFactory } from './conformance';
import { durableEntities } from './entities';
import { durableManagedTables, ensureTypeOrmDurableSchema } from './schema';
import { TypeOrmStateStore } from './typeorm-state-store';

/**
 * The `schema` option against real Postgres and MySQL: the durable tables in a schema (Postgres) or
 * database (MySQL) of their own while the connection's default stays where it was. The store's
 * connections are set up so an unqualified table resolves nowhere (Postgres `search_path` pointing at
 * a missing schema, MySQL with no default database): any statement that forgets the schema fails.
 * Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;
const SCHEMA = 'durable_own_typeorm';

type Dialect = 'postgres' | 'mysql';
/** The store's connection (unqualified names resolve nowhere) and an admin one on the default. */
const conn: Partial<Record<Dialect, { store: DataSourceOptions; admin: DataSourceOptions }>> = {};
const bootErrors: Partial<Record<Dialect, unknown>> = {};
let pg: StartedPostgreSqlContainer | undefined;
let mysql: StartedMySqlContainer | undefined;

beforeAll(async () => {
  try {
    let url = process.env.DURABLE_TEST_PG_URL;
    if (!url && !skipped) {
      pg = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = pg.getConnectionUri();
    }
    if (url) {
      const base = new URL(url);
      base.pathname = `${base.pathname}_typeorm_schema`;
      const admin = new DataSource({ type: 'postgres', url });
      await admin.initialize();
      const name = base.pathname.slice(1);
      if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).length === 0)
        await admin.query(`CREATE DATABASE "${name}"`).catch(() => undefined);
      await admin.destroy();
      conn.postgres = {
        admin: { type: 'postgres', url: base.toString() },
        store: {
          type: 'postgres',
          url: base.toString(),
          extra: { options: '-c search_path=nowhere' },
        },
      };
    }
  } catch (err) {
    bootErrors.postgres = err;
  }
  try {
    let url = process.env.DURABLE_TEST_MYSQL_URL;
    if (!url && !skipped) {
      mysql = await new MySqlContainer('mysql:8.0').withRootPassword('durable').start();
      url = `mysql://root:durable@${mysql.getHost()}:${mysql.getPort()}/${mysql.getDatabase()}`;
    }
    if (url) {
      const noDatabase = new URL(url);
      noDatabase.pathname = '/';
      conn.mysql = {
        admin: { type: 'mysql', url },
        store: { type: 'mysql', url: noDatabase.toString() },
      };
    }
  } catch (err) {
    bootErrors.mysql = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  for (const dialect of ['postgres', 'mysql'] as const) {
    const options = conn[dialect]?.admin;
    if (!options) continue;
    const ds = new DataSource(options);
    await ds.initialize();
    await ds
      .query(
        dialect === 'postgres'
          ? `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`
          : `DROP DATABASE IF EXISTS \`${SCHEMA}\``,
      )
      .catch(() => undefined);
    await ds.destroy();
  }
  await pg?.stop();
  await mysql?.stop();
});

function options(dialect: Dialect, role: 'store' | 'admin'): DataSourceOptions {
  if (bootErrors[dialect])
    throw new StateStoreUnavailableError(`${dialect} unavailable: ${String(bootErrors[dialect])}`);
  const found = conn[dialect]?.[role];
  if (!found) throw new StateStoreUnavailableError(`${dialect} not started`);
  return found;
}

async function withAdmin<T>(dialect: Dialect, fn: (ds: DataSource) => Promise<T>): Promise<T> {
  const ds = new DataSource(options(dialect, 'admin'));
  await ds.initialize();
  try {
    return await fn(ds);
  } finally {
    await ds.destroy();
  }
}

async function durableTablesIn(dialect: Dialect, schema: string): Promise<string[]> {
  return withAdmin(dialect, async (ds) => {
    const rows: Array<{ name?: string; NAME?: string }> = await ds.query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${dialect === 'postgres' ? '$1' : '?'}`,
      [schema],
    );
    return rows
      .map((r) => (r.name ?? r.NAME) as string)
      .filter((name) => durableManagedTables().includes(name))
      .sort();
  });
}

async function defaultSchema(dialect: Dialect): Promise<string> {
  if (dialect === 'postgres') return 'public';
  return withAdmin(dialect, async (ds) => (await ds.query('SELECT DATABASE() AS db'))[0].db);
}

for (const dialect of ['postgres', 'mysql'] as const) {
  describe(`TypeORM (${dialect}) with schema [real engine]`, () => {
    runStateStoreContract(`TypeORM (${dialect}, schema)`, async (): Promise<StateStoreContext> => {
      return makeTypeOrmStoreFactory(options(dialect, 'store'), { schema: SCHEMA })();
    });

    it('creates the schema on boot, repairs drift in it, and nothing lands in the default', async (ctx) => {
      if (!conn[dialect]) return ctx.skip();
      await withAdmin(dialect, (ds) =>
        ds.query(
          dialect === 'postgres'
            ? `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`
            : `DROP DATABASE IF EXISTS \`${SCHEMA}\``,
        ),
      );
      const ds = new DataSource({
        ...options(dialect, 'store'),
        entities: durableEntities({ schema: SCHEMA }),
      });
      await ds.initialize();
      try {
        const warnings: string[] = [];
        const logger = { warn: (m: string) => warnings.push(m) };
        const store = new TypeOrmStateStore(ds, { schema: SCHEMA, schemaLogger: logger });
        await store.ensureSchema();
        await store.ensureSchema();
        expect(warnings).toEqual([]);
        expect(await durableTablesIn(dialect, SCHEMA)).toEqual([...durableManagedTables()].sort());
        expect(await durableTablesIn(dialect, await defaultSchema(dialect))).toEqual([]);

        const q = (id: string) => ds.driver.escape(id);
        await withAdmin(dialect, (admin) =>
          admin.query(
            `ALTER TABLE ${q(SCHEMA)}.${q('durable_schedules')} DROP COLUMN ${q('tenant_kind')}`,
          ),
        );
        await ensureTypeOrmDurableSchema(ds, { logger });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('added column durable_schedules.tenant_kind');
      } finally {
        await ds.destroy();
      }
    });

    it('runs on the app transaction with the schema tables', async (ctx) => {
      if (!conn[dialect]) return ctx.skip();
      const ds = new DataSource({
        ...options(dialect, 'store'),
        entities: durableEntities({ schema: SCHEMA }),
      });
      await ds.initialize();
      try {
        const store = new TypeOrmStateStore(ds, { schema: SCHEMA });
        await store.ensureSchema();
        const at = new Date();
        await ds.transaction(async (em) => {
          await em.getRepository('WorkflowRunEntity').insert({
            id: 'in-tx',
            workflow: 'w',
            workflowVersion: '1',
            status: 'pending',
            namespace: 'default',
            createdAt: at,
            updatedAt: at,
          });
        });
        expect((await store.getRun('in-tx'))?.status).toBe('pending');
      } finally {
        await ds.destroy();
      }
    });
  });
}
