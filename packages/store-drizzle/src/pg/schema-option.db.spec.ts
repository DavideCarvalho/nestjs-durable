import {
  type StateStoreContext,
  StateStoreUnavailableError,
  runStateStoreContract,
} from '@dudousxd/nestjs-durable-testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import pg from 'pg';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { durablePgDdl, ensureDrizzlePgDurableSchema } from './ddl';
import { type DrizzlePgDatabase, DrizzlePgStateStore } from './drizzle-pg-state-store';
import { durablePgManagedTables, durablePgTables } from './schema';
import { dedicatedPgDatabaseUrl } from './test-database';

/**
 * The `schema` option against a real Postgres: the durable tables live in their own schema while the
 * connection's default stays `public`. The pools run with `search_path` pointing at a schema that
 * does not exist, so any statement the store issues without naming the schema fails instead of
 * quietly landing in `public`. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
const SCHEMA = 'durable_own';

let container: StartedPostgreSqlContainer | undefined;
let url: string | undefined;
let bootError: unknown;
let pool: pg.Pool | undefined;
let sqlJs: postgres.Sql | undefined;
let admin: pg.Pool | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    if (externalUrl) url = await dedicatedPgDatabaseUrl(externalUrl, 'drizzle_schema');
    else {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = container.getConnectionUri();
    }
    admin = new pg.Pool({ connectionString: url, max: 2 });
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    for (const t of durablePgManagedTables()) await admin.query(`DROP TABLE IF EXISTS "${t}"`);
    // Unqualified names resolve nowhere: a statement that forgets the schema errors out.
    pool = new pg.Pool({ connectionString: url, max: 10, options: '-c search_path=nowhere' });
    sqlJs = postgres(url, {
      max: 4,
      onnotice: () => {},
      connection: { search_path: 'nowhere' },
    });
  } catch (err) {
    bootError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
  await pool?.end();
  await sqlJs?.end();
  await admin?.end();
  await container?.stop();
});

function live(): pg.Pool {
  if (skipped) throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
  if (bootError) throw new StateStoreUnavailableError(`Postgres unavailable: ${String(bootError)}`);
  if (!pool) throw new StateStoreUnavailableError('Postgres not started');
  return pool;
}

async function truncate(): Promise<void> {
  const tables = durablePgManagedTables()
    .map((t) => `"${SCHEMA}"."${t}"`)
    .join(', ');
  await admin?.query(`TRUNCATE ${tables} RESTART IDENTITY`);
}

async function durableTablesIn(schema: string): Promise<string[]> {
  const { rows } = await (admin as pg.Pool).query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'durable\\_%' ORDER BY 1",
    [schema],
  );
  return rows.map((r) => r.name);
}

describe('durablePgTables / durablePgDdl', () => {
  it('builds every table in the schema, and leaves the default tables unqualified', () => {
    for (const table of Object.values(durablePgTables(SCHEMA)))
      expect(getTableConfig(table).schema).toBe(SCHEMA);
    for (const table of Object.values(durablePgTables()))
      expect(getTableConfig(table).schema).toBeUndefined();
    expect(durablePgTables(SCHEMA)).toBe(durablePgTables(SCHEMA));
  });

  it('qualifies every table in the DDL and creates the schema first', () => {
    const ddl = durablePgDdl(SCHEMA);
    expect(ddl[0]).toBe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    for (const statement of ddl.slice(1)) {
      expect(statement).toMatch(new RegExp(`"${SCHEMA}"\\."durable_`));
      expect(statement).not.toMatch(/(TABLE IF NOT EXISTS|ALTER TABLE| ON) "[^"]+"(?!\.)/);
    }
  });

  it('rejects a schema that is not a plain identifier', () => {
    expect(() => durablePgTables('a"b')).toThrow(/invalid schema/);
    expect(
      () => new DrizzlePgStateStore({} as DrizzlePgDatabase, { schema: 'x'.repeat(64) }),
    ).toThrow(/invalid schema/);
  });
});

describe('Drizzle Postgres with schema [real engine]', () => {
  runStateStoreContract('Drizzle Postgres (schema)', async (): Promise<StateStoreContext> => {
    let statements = 0;
    const log: string[] = [];
    const db = drizzle(live(), {
      logger: {
        logQuery: (query: string, params: unknown[]) => {
          statements += 1;
          log.push(`${query} ${JSON.stringify(params)}`);
        },
      },
    });
    const store = new DrizzlePgStateStore(db, { schema: SCHEMA });
    await store.ensureSchema();
    await truncate();
    return {
      store,
      // The builder path (postgres-js has no hot path) on the same tables.
      peerStore: new DrizzlePgStateStore(drizzlePostgresJs(sqlJs as postgres.Sql), {
        schema: SCHEMA,
      }),
      statements: () => statements,
      statementLog: () => log,
      cleanup: truncate,
    };
  });

  it('creates the schema on boot, and nothing lands in public', async (ctx) => {
    if (!pool || bootError) return ctx.skip();
    await admin?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    const warnings: string[] = [];
    const store = new DrizzlePgStateStore(drizzle(pool), {
      schema: SCHEMA,
      schemaLogger: { warn: (m) => warnings.push(m) },
    });
    await store.ensureSchema();
    await store.ensureSchema();
    expect(warnings).toEqual([]);
    expect(await durableTablesIn(SCHEMA)).toEqual([...durablePgManagedTables()].sort());
    expect(await durableTablesIn('public')).toEqual([]);
  });

  it('repairs a drifted table in the schema, reading the catalog of that schema', async (ctx) => {
    if (!pool || bootError) return ctx.skip();
    const db = drizzle(pool);
    await ensureDrizzlePgDurableSchema(db, { schema: SCHEMA });
    await admin?.query(`DROP INDEX "${SCHEMA}"."durable_runs_tags_gin_idx"`);
    await admin?.query(`ALTER TABLE "${SCHEMA}"."durable_schedules" DROP COLUMN "tenant_kind"`);
    const warnings: string[] = [];
    await ensureDrizzlePgDurableSchema(db, {
      schema: SCHEMA,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'created index durable_runs_tags_gin_idx on durable_workflow_runs',
    );
    expect(warnings[0]).toContain('added column durable_schedules.tenant_kind');
    expect(await durableTablesIn('public')).toEqual([]);
  });

  it('runs inside an app transaction on the schema tables', async (ctx) => {
    if (!pool || bootError) return ctx.skip();
    const db = drizzle(pool);
    const store = new DrizzlePgStateStore(db, { schema: SCHEMA });
    await store.ensureSchema();
    const at = new Date();
    await db.transaction(async (tx) => {
      await new DrizzlePgStateStore(tx as unknown as DrizzlePgDatabase, {
        schema: SCHEMA,
      }).createRun({
        id: 'in-tx',
        workflow: 'w',
        workflowVersion: '1',
        status: 'pending',
        input: {},
        createdAt: at,
        updatedAt: at,
      });
    });
    expect((await store.getRun('in-tx'))?.status).toBe('pending');
    const { rows } = await (admin as pg.Pool).query(
      `SELECT id FROM "${SCHEMA}"."durable_workflow_runs" WHERE id = 'in-tx'`,
    );
    expect(rows).toHaveLength(1);
  });
});
