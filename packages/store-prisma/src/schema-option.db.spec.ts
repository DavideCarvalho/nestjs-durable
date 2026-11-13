import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runStateStoreContract } from '@dudousxd/nestjs-durable-testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaStateStore } from './prisma-state-store';
import { durableManagedTables } from './schema';

/**
 * The `schema` option against a real Postgres (Prisma has no `@@schema` on MySQL, where the option
 * fails at construction): the durable models carry `@@schema(...)`
 * (Prisma's multi-schema support) so the client qualifies its own queries, and the store's `schema`
 * option qualifies its raw SQL. The client connects with a default that holds no durable table
 * (Postgres: `?schema=` at a schema that does not exist; MySQL: an empty database), so a raw
 * statement that forgets the schema fails instead of running somewhere else. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 240_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;
const SCHEMA = 'durable_own_prisma';
const pkgRoot = resolve(__dirname, '..');

type Dialect = 'postgres';
const clients: Partial<Record<Dialect, any>> = {};
const admins: Partial<Record<Dialect, any>> = {};
const defaults: Partial<Record<Dialect, string>> = {};
const errors: Partial<Record<Dialect, unknown>> = {};
let pg: StartedPostgreSqlContainer | undefined;

/**
 * The test schema for `dialect` with every model in {@link SCHEMA}: `schemas` on the datasource and
 * `@@schema` on each model — what an app adds to the models it copied in.
 */
function multiSchemaFile(dialect: Dialect): string {
  const source = 'test.pg.prisma';
  const env = 'PRISMA_PG_URL';
  const text = readFileSync(resolve(pkgRoot, 'prisma', source), 'utf8')
    .replace(`url      = env("${env}")`, `url      = env("${env}")\n  schemas  = ["${SCHEMA}"]`)
    .replace(/output\s+=\s+"[^"]+"/, `output   = "./${dialect}-schema-client"`)
    .replace(/(\n\s*@@map\("durable_\w+"\))/g, `$1\n  @@schema("${SCHEMA}")`);
  const dir = resolve(pkgRoot, 'generated');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${dialect}-schema.prisma`);
  writeFileSync(file, text);
  return file;
}

function runPrisma(args: string[], env: Record<string, string>): void {
  execFileSync('npx', ['prisma', ...args], {
    cwd: pkgRoot,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
}

async function setUp(dialect: Dialect, baseUrl: string): Promise<void> {
  const env = 'PRISMA_PG_URL';
  const admin = new URL(baseUrl);
  admin.pathname = `/${decodeURIComponent(admin.pathname.slice(1)) || 'durable'}_prisma_schema`;
  const file = multiSchemaFile(dialect);
  runPrisma(['generate', '--schema', file], { [env]: admin.toString() });
  runPrisma(['db', 'push', '--schema', file, '--skip-generate', '--accept-data-loss'], {
    [env]: admin.toString(),
  });
  const { PrismaClient } = await import('../generated/postgres-schema-client/index.js');
  admins[dialect] = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  const store = new URL(admin);
  store.searchParams.set('schema', 'nowhere');
  defaults.postgres = 'public';
  clients[dialect] = new PrismaClient({ datasources: { db: { url: store.toString() } } });
  await clients[dialect].$connect();
}

beforeAll(async () => {
  try {
    let url = process.env.DURABLE_TEST_PG_URL;
    if (!url && !skipped) {
      pg = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = pg.getConnectionUri();
    }
    if (url) await setUp('postgres', url);
  } catch (err) {
    errors.postgres = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  for (const client of [...Object.values(clients), ...Object.values(admins)])
    await client?.$disconnect?.();
  await pg?.stop();
});

async function truncate(client: any): Promise<void> {
  await client.durableStepCheckpoint.deleteMany();
  await client.durableSignalWaiter.deleteMany();
  await client.durableBufferedSignal.deleteMany();
  await client.durableBufferedEvent.deleteMany();
  await client.durableSignalId.deleteMany();
  await client.durableSchedule.deleteMany();
  await client.durableRunAttribute.deleteMany();
  await client.durableWorkflowRun.deleteMany();
}

async function durableTablesIn(dialect: Dialect, schema: string): Promise<string[]> {
  const rows: Array<{ name: string }> = await admins[dialect].$queryRawUnsafe(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1',
    schema,
  );
  return rows
    .map((r) => r.name)
    .filter((name) => durableManagedTables().includes(name))
    .sort();
}

for (const dialect of ['postgres'] as const) {
  describe(`Prisma (${dialect}) with schema [real engine]`, () => {
    runStateStoreContract(`Prisma (${dialect}, schema)`, async () => {
      const client = clients[dialect];
      if (errors[dialect] || !client) {
        throw new (await import('@dudousxd/nestjs-durable-testing')).StateStoreUnavailableError(
          `Prisma ${dialect} unavailable: ${String(errors[dialect] ?? 'not started')}`,
        );
      }
      await truncate(client);
      return {
        store: new PrismaStateStore(client, { schema: SCHEMA }),
        peerStore: new PrismaStateStore(client, { schema: SCHEMA }),
        supportsTagFilter: true,
        implicitTransactions: true,
        cleanup: async () => undefined,
      };
    });

    it('keeps every durable table in the schema, none in the default', async (ctx) => {
      if (!clients[dialect]) return ctx.skip();
      expect(await durableTablesIn(dialect, SCHEMA)).toEqual([...durableManagedTables()].sort());
      expect(await durableTablesIn(dialect, defaults[dialect] as string)).toEqual([]);
    });
  });
}

describe('Prisma schema option (validation)', () => {
  it('rejects a bad name, SQLite and MySQL', () => {
    const sqlite = { _activeProvider: 'sqlite' } as never;
    expect(() => new PrismaStateStore(sqlite, { schema: 'durable' })).toThrow(
      /not supported on SQLite/,
    );
    const mysql = { _activeProvider: 'mysql', $queryRawUnsafe: () => undefined } as never;
    expect(() => new PrismaStateStore(mysql, { schema: 'durable' })).toThrow(
      /not supported on MySQL/,
    );
    expect(() => new PrismaStateStore(sqlite, { schema: 'a-b' })).toThrow(/invalid schema/);
  });
});
