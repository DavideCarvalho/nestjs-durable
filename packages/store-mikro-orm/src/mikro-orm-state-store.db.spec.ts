import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import {
  type StateStoreContext,
  StateStoreUnavailableError,
  runStateStoreContract,
} from '@dudousxd/nestjs-durable-testing';
import { MikroORM as MySqlMikroORM } from '@mikro-orm/mysql';
import { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMikroOrmStoreFactory } from './conformance';
import { ENTITIES } from './entities';

/**
 * Real-engine matrix for the MikroORM adapter: the SHARED cross-store contract against Postgres and
 * MySQL (testcontainers). Validates the dialect-aware `ensureSchema` (`updateSchema`), the raw EXISTS
 * search-attribute pushdown (whose identifier quoting + column-name resolution are driver-specific),
 * and the JSON-column tag LIKE (which needs a per-dialect text cast) against the real engines. Run
 * with `pnpm test:db`. Skips cleanly when Docker is unavailable or `SKIP_TESTCONTAINERS` is set.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;
// An existing database instead of a testcontainer, like the schema-repair specs.
const externalPgUrl = process.env.DURABLE_TEST_PG_URL;
const externalMysqlUrl = process.env.DURABLE_TEST_MYSQL_URL;

type Factory = ReturnType<typeof makeMikroOrmStoreFactory>;

/**
 * A database of this spec's own on a shared server: `<base>_mikro_orm`, created when missing. Every
 * store's db spec gets the same `DURABLE_TEST_*_URL`, and each defines the `durable_*` tables its own
 * way (Prisma's `wake_at` is a BIGINT, MikroORM's a timestamp), so one database shared between specs
 * running at once lets one spec's schema clobber another's mid-run. Idempotent, and safe when two
 * specs race to create it.
 */
async function dedicatedDatabaseUrl(
  dialect: 'postgres' | 'mysql',
  baseUrl: string,
): Promise<string> {
  const target = new URL(baseUrl);
  const name = `${decodeURIComponent(target.pathname.slice(1)) || dialect}_mikro_orm`;
  if (dialect === 'mysql') {
    const admin = await MySqlMikroORM.init({ clientUrl: baseUrl, entities: [...ENTITIES] });
    try {
      await admin.em.getConnection().execute(`create database if not exists \`${name}\``);
    } finally {
      await admin.close(true);
    }
  } else {
    const admin = await PostgresMikroORM.init({ clientUrl: baseUrl, entities: [...ENTITIES] });
    try {
      const connection = admin.em.getConnection();
      const rows = await connection.execute('select 1 from pg_database where datname = ?', [name]);
      if (rows.length === 0) {
        await connection
          .execute(`create database "${name}"`)
          .catch((err: Error & { code?: string }) => {
            // 42P04 duplicate_database; 23505 when a concurrent CREATE wins the catalog insert.
            const raced =
              ['42P04', '23505'].includes(err.code ?? '') ||
              /already exists|duplicate key/.test(err.message);
            if (!raced) throw err;
          });
      }
    } finally {
      await admin.close(true);
    }
  }
  target.pathname = `/${name}`;
  return target.toString();
}

// --- Postgres ---------------------------------------------------------------------------------

let pg: StartedPostgreSqlContainer | undefined;
let pgError: unknown;
let pgFactory: Factory | undefined;

beforeAll(async () => {
  if (externalPgUrl) {
    pgFactory = makeMikroOrmStoreFactory((options) => PostgresMikroORM.init(options), {
      clientUrl: await dedicatedDatabaseUrl('postgres', externalPgUrl),
    });
    return;
  }
  if (skipped) return;
  try {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    pgFactory = makeMikroOrmStoreFactory((options) => PostgresMikroORM.init(options), {
      host: pg.getHost(),
      port: pg.getPort(),
      user: pg.getUsername(),
      password: pg.getPassword(),
      dbName: pg.getDatabase(),
    });
  } catch (err) {
    pgError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await pg?.stop();
});

describe('MikroORM (Postgres) [real engine]', () => {
  runStateStoreContract('MikroORM (Postgres)', async (): Promise<StateStoreContext> => {
    if (skipped && !externalPgUrl) throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
    if (pgError)
      throw new StateStoreUnavailableError(
        `Postgres testcontainer unavailable (is Docker running?): ${String(pgError)}`,
      );
    if (!pgFactory) throw new StateStoreUnavailableError('Postgres container not started');
    return pgFactory();
  });
});

// --- MySQL ------------------------------------------------------------------------------------

let mysql: StartedMySqlContainer | undefined;
let mysqlError: unknown;
let mysqlFactory: Factory | undefined;

beforeAll(async () => {
  if (externalMysqlUrl) {
    mysqlFactory = makeMikroOrmStoreFactory((options) => MySqlMikroORM.init(options), {
      clientUrl: await dedicatedDatabaseUrl('mysql', externalMysqlUrl),
    });
    return;
  }
  if (skipped) return;
  try {
    mysql = await new MySqlContainer('mysql:8.0').start();
    mysqlFactory = makeMikroOrmStoreFactory((options) => MySqlMikroORM.init(options), {
      host: mysql.getHost(),
      port: mysql.getPort(),
      user: mysql.getUsername(),
      password: mysql.getUserPassword(),
      dbName: mysql.getDatabase(),
    });
  } catch (err) {
    mysqlError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await mysql?.stop();
});

describe('MikroORM (MySQL) [real engine]', () => {
  runStateStoreContract('MikroORM (MySQL)', async (): Promise<StateStoreContext> => {
    if (skipped && !externalMysqlUrl)
      throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
    if (mysqlError)
      throw new StateStoreUnavailableError(
        `MySQL testcontainer unavailable (is Docker running?): ${String(mysqlError)}`,
      );
    if (!mysqlFactory) throw new StateStoreUnavailableError('MySQL container not started');
    return mysqlFactory();
  });
});

// --- Buffered child completions through the engine, on each real engine ---------------------------

/**
 * A duplicate child notification compares its completion with the one the parent already holds. A
 * JSON column (MySQL `json`, Postgres `jsonb`) hands the parent's copy back with its keys reordered,
 * so a byte comparison saw two different completions and buffered a row nothing ever consumed.
 */
async function duplicateNotificationLeavesNoBuffer(factory: Factory | undefined): Promise<void> {
  if (!factory) throw new Error('backend not started');
  const { store, cleanup } = await factory();
  const engine = new WorkflowEngine({ store });
  try {
    const value = { zeta: 1, alpha: { y: 2, b: 3 }, ok: 'yes' };
    engine.register('fetch', '1', async () => value);
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child('fetch', {});
      await ctx.waitForSignal('more');
      return out;
    });
    await engine.start('parent', {}, 'p');
    const deadline = Date.now() + 15_000;
    // Suspended on the signal, past the child: the parent also suspends while the child runs, and a
    // notification delivered then is not a duplicate yet.
    const pastChild = async () =>
      (await store.getRun('p'))?.status === 'suspended' &&
      (await store.listCheckpoints('p')).some(
        (cp) => cp.name.startsWith('signal:child:') && cp.status === 'completed',
      );
    while (!(await pastChild())) {
      if (Date.now() > deadline) throw new Error('parent never suspended past its child');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await (
      engine as unknown as { deliverToParent(token: string, c: unknown): Promise<void> }
    ).deliverToParent('child:p.child.0', { ok: true, value });
    // A root run's completion has no parent to buffer for either.
    engine.register('root', '1', async () => ({ b: 1, a: 2 }));
    await engine.start('root', {}, 'root-run');
    while ((await store.getRun('root-run'))?.status !== 'completed') {
      if (Date.now() > deadline) throw new Error('root never completed');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await engine.drain(5_000);
    expect(await store.listBufferedSignals?.('child:', undefined, 100)).toEqual([]);
  } finally {
    await engine.drain(5_000);
    await cleanup?.();
  }
}

describe.skipIf(skipped)('MikroORM buffered child completions [real engine]', () => {
  it('Postgres: a duplicate notification read back from jsonb buffers nothing', async () => {
    await duplicateNotificationLeavesNoBuffer(pgFactory);
  });
  it('MySQL: a duplicate notification read back from a json column buffers nothing', async () => {
    await duplicateNotificationLeavesNoBuffer(mysqlFactory);
  });
});
