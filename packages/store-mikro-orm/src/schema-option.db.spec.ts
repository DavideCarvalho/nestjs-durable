import {
  type StateStoreContext,
  StateStoreUnavailableError,
  runStateStoreContract,
} from '@dudousxd/nestjs-durable-testing';
import type { MikroORM, Options } from '@mikro-orm/core';
import { MikroORM as MySqlMikroORM } from '@mikro-orm/mysql';
import { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMikroOrmStoreFactory } from './conformance';
import { WorkflowRunEntity, durableEntities } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';
import { durableManagedTables, ensureMikroOrmDurableSchema } from './schema';

/**
 * The `schema` option against real Postgres and MySQL: the durable tables in a schema (Postgres) or
 * database (MySQL) of their own while the connection's default stays where it was. The store's
 * connection defaults to an EMPTY schema/database (Postgres: `search_path` at a schema that does not
 * exist; MySQL: a fresh empty database), so a statement that forgets the schema fails instead of
 * quietly running somewhere else. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;
const SCHEMA = 'durable_own_mikro';

type Dialect = 'postgres' | 'mysql';
const init: Record<Dialect, (options: Options) => Promise<MikroORM>> = {
  postgres: (options) => PostgresMikroORM.init(options),
  mysql: (options) => MySqlMikroORM.init(options),
};
/** The store's connection URL and an admin one, per dialect. */
const urls: Partial<Record<Dialect, { store: string; admin: string; defaultSchema: string }>> = {};
const bootErrors: Partial<Record<Dialect, unknown>> = {};
let pg: StartedPostgreSqlContainer | undefined;
let mysql: StartedMySqlContainer | undefined;

async function adminExec(dialect: Dialect, url: string, sql: string, params: unknown[] = []) {
  const orm = await init[dialect]({ clientUrl: url, entities: durableEntities() });
  try {
    return (await orm.em.getConnection().execute(sql, params)) as Array<Record<string, unknown>>;
  } finally {
    await orm.close(true);
  }
}

beforeAll(async () => {
  try {
    let url = process.env.DURABLE_TEST_PG_URL;
    if (!url && !skipped) {
      pg = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = pg.getConnectionUri();
    }
    if (url) {
      const db = new URL(url);
      const name = `${db.pathname.slice(1)}_mikro_schema`;
      const exists = await adminExec(
        'postgres',
        url,
        'select 1 from pg_database where datname = ?',
        [name],
      );
      if (exists.length === 0) await adminExec('postgres', url, `create database "${name}"`);
      db.pathname = `/${name}`;
      const store = new URL(db);
      store.searchParams.set('options', '-c search_path=nowhere');
      urls.postgres = { admin: db.toString(), store: store.toString(), defaultSchema: 'public' };
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
      const empty = new URL(url);
      const name = `${empty.pathname.slice(1)}_mikro_schema_default`;
      await adminExec('mysql', url, `drop database if exists \`${name}\``);
      await adminExec('mysql', url, `create database \`${name}\``);
      empty.pathname = `/${name}`;
      urls.mysql = { admin: url, store: empty.toString(), defaultSchema: name };
    }
  } catch (err) {
    bootErrors.mysql = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  for (const dialect of ['postgres', 'mysql'] as const) {
    const url = urls[dialect]?.admin;
    if (!url) continue;
    await adminExec(
      dialect,
      url,
      dialect === 'postgres'
        ? `drop schema if exists "${SCHEMA}" cascade`
        : `drop database if exists \`${SCHEMA}\``,
    ).catch(() => undefined);
  }
  await pg?.stop();
  await mysql?.stop();
});

function live(dialect: Dialect): { store: string; admin: string; defaultSchema: string } {
  if (bootErrors[dialect])
    throw new StateStoreUnavailableError(`${dialect} unavailable: ${String(bootErrors[dialect])}`);
  const found = urls[dialect];
  if (!found) throw new StateStoreUnavailableError(`${dialect} not started`);
  return found;
}

async function durableTablesIn(dialect: Dialect, schema: string): Promise<string[]> {
  const rows = await adminExec(
    dialect,
    live(dialect).admin,
    'select table_name as name from information_schema.tables where table_schema = ?',
    [schema],
  );
  return rows
    .map((r) => String(r.name ?? r.NAME ?? r.TABLE_NAME))
    .filter((name) => name.startsWith('durable_'))
    .sort();
}

for (const dialect of ['postgres', 'mysql'] as const) {
  describe(`MikroORM (${dialect}) with schema [real engine]`, () => {
    runStateStoreContract(`MikroORM (${dialect}, schema)`, async (): Promise<StateStoreContext> => {
      return makeMikroOrmStoreFactory(
        init[dialect],
        { clientUrl: live(dialect).store },
        { schema: SCHEMA },
      )();
    });

    it('creates the schema on boot, repairs drift in it, and nothing lands in the default', async (ctx) => {
      if (!urls[dialect]) return ctx.skip();
      await adminExec(
        dialect,
        live(dialect).admin,
        dialect === 'postgres'
          ? `drop schema if exists "${SCHEMA}" cascade`
          : `drop database if exists \`${SCHEMA}\``,
      );
      const orm = await init[dialect]({
        clientUrl: live(dialect).store,
        entities: durableEntities({ schema: SCHEMA }),
        allowGlobalContext: true,
      });
      try {
        const warnings: string[] = [];
        const logger = { warn: (m: string) => warnings.push(m) };
        const store = new MikroOrmStateStore(orm, { schema: SCHEMA, schemaLogger: logger });
        await store.ensureSchema();
        await store.ensureSchema();
        expect(warnings).toEqual([]);
        expect(await durableTablesIn(dialect, SCHEMA)).toEqual(
          [...durableManagedTables(), 'durable_schema_meta'].sort(),
        );
        expect(await durableTablesIn(dialect, live(dialect).defaultSchema)).toEqual([]);

        // A column dropped by hand, with the marker cleared so the fingerprint gate re-heals.
        const q = (id: string) => orm.em.getPlatform().quoteIdentifier(id);
        await adminExec(
          dialect,
          live(dialect).admin,
          `alter table ${q(SCHEMA)}.${q('durable_schedules')} drop column ${q('tenant_kind')}`,
        );
        await adminExec(
          dialect,
          live(dialect).admin,
          `delete from ${q(SCHEMA)}.${q('durable_schema_meta')}`,
        );
        await ensureMikroOrmDurableSchema(orm, { logger });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('durable_schedules');
        expect(warnings[0]).toContain('tenant_kind');
        expect(await durableTablesIn(dialect, live(dialect).defaultSchema)).toEqual([]);
      } finally {
        await orm.close(true);
      }
    });

    it('runs inside an app transaction on the schema tables', async (ctx) => {
      if (!urls[dialect]) return ctx.skip();
      const orm = await init[dialect]({
        clientUrl: live(dialect).store,
        entities: durableEntities({ schema: SCHEMA }),
        allowGlobalContext: true,
      });
      try {
        const store = new MikroOrmStateStore(orm, { schema: SCHEMA });
        await store.ensureSchema();
        const at = new Date();
        await orm.em.fork().transactional(async (em) => {
          em.create(WorkflowRunEntity, {
            id: 'in-tx',
            workflow: 'w',
            workflowVersion: '1',
            status: 'pending',
            namespace: 'default',
            createdAt: at,
            updatedAt: at,
          } as never);
        });
        expect((await store.getRun('in-tx'))?.status).toBe('pending');
      } finally {
        await orm.close(true);
      }
    });
  });
}

describe('MikroORM schema option (validation)', () => {
  it('fails when the store and the registered entities disagree', async (ctx) => {
    if (!urls.postgres) return ctx.skip();
    const orm = await PostgresMikroORM.init({
      clientUrl: live('postgres').admin,
      entities: durableEntities(),
    });
    try {
      expect(() => new MikroOrmStateStore(orm, { schema: SCHEMA })).toThrow(
        /registered without one/,
      );
    } finally {
      await orm.close(true);
    }
  });
});
