import { MikroORM as MySqlMikroORM } from '@mikro-orm/mysql';
import { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';
import { durableManagedTables, ensureMikroOrmDurableSchema } from './schema';

/**
 * The schema-repair warning against a real Postgres: MikroORM's own diff decides what is missing,
 * so this pins the Postgres statement shapes it emits. Uses `DURABLE_TEST_PG_URL` when set (a
 * dedicated database is created on that server and dropped at the end), else a testcontainers
 * `postgres:16-alpine`; the MySQL case likewise uses `DURABLE_TEST_MYSQL_URL` or a testcontainers
 * `mysql:8.0`. Skips without Docker or with `SKIP_TESTCONTAINERS`. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
const DATABASE = 'durable_schema_repair_mikro_orm';

let container: StartedPostgreSqlContainer | undefined;
let baseUrl: string | undefined;
let url: string | undefined;

async function admin(statement: string): Promise<void> {
  const orm = await PostgresMikroORM.init({ clientUrl: baseUrl, entities: [...ENTITIES] });
  try {
    await orm.em.getConnection().execute(statement);
  } finally {
    await orm.close(true);
  }
}

beforeAll(async () => {
  if (skipped) return;
  if (externalUrl) baseUrl = externalUrl;
  else {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    baseUrl = container.getConnectionUri();
  }
  await admin(`drop database if exists "${DATABASE}" with (force)`);
  await admin(`create database "${DATABASE}"`);
  const target = new URL(baseUrl);
  target.pathname = `/${DATABASE}`;
  url = target.toString();
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  if (baseUrl) await admin(`drop database if exists "${DATABASE}" with (force)`).catch(() => {});
  await container?.stop();
});

function recordingLogger(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}

describe.skipIf(skipped)('ensureMikroOrmDurableSchema repair warning [real Postgres]', () => {
  let orm: PostgresMikroORM | undefined;

  async function boot(): Promise<PostgresMikroORM> {
    orm = await PostgresMikroORM.init({
      clientUrl: url,
      entities: [...ENTITIES],
      allowGlobalContext: true,
    });
    for (const table of ['durable_schema_meta', ...durableManagedTables()])
      await orm.em.getConnection().execute(`drop table if exists "${table}" cascade`);
    return orm;
  }

  /** Forget the applied fingerprint, as an upgrade that changes the schema would. */
  async function clearMarker(): Promise<void> {
    await orm?.em.getConnection().execute('delete from durable_schema_meta');
  }

  afterEach(async () => {
    await orm?.close(true);
    orm = undefined;
  });

  it('logs nothing on a fresh install, a steady-state boot, or a re-check of a current schema', async () => {
    const o = await boot();
    const logger = recordingLogger();
    await ensureMikroOrmDurableSchema(o, { logger });
    await ensureMikroOrmDurableSchema(o, { logger });
    await clearMarker();
    await ensureMikroOrmDurableSchema(o, { logger });
    expect(logger.messages).toEqual([]);
  });

  it('logs ONE warning listing a dropped column, a dropped index and a dropped table', async () => {
    const o = await boot();
    await ensureMikroOrmDurableSchema(o, { logger: recordingLogger() });
    const connection = o.em.getConnection();
    await connection.execute('alter table "durable_workflow_runs" drop column "origin"');
    await connection.execute('drop index "durable_schedules_due_idx"');
    await connection.execute('drop table "durable_buffered_events"');
    await clearMarker();

    const logger = recordingLogger();
    await new MikroOrmStateStore(o, { schemaLogger: logger }).ensureSchema();

    expect(logger.messages).toHaveLength(1);
    const [message] = logger.messages;
    expect(message).toContain(
      '[nestjs-durable] store-mikro-orm repaired the durable schema at boot:',
    );
    expect(message).toContain('created table durable_buffered_events');
    expect(message).toContain('added column durable_workflow_runs.origin');
    expect(message).toContain('created index durable_schedules_due_idx on durable_schedules');

    await clearMarker();
    const after = recordingLogger();
    await ensureMikroOrmDurableSchema(o, { logger: after });
    expect(after.messages).toEqual([]);
  });

  it('leaves the timestamp columns an older version created alone (timestamptz is already microsecond)', async () => {
    const o = await boot();
    await ensureMikroOrmDurableSchema(o, { logger: recordingLogger() });
    // Older versions declared no precision, so Postgres holds the typmod-less `timestamptz`.
    await o.em
      .getConnection()
      .execute(
        'alter table "durable_workflow_runs" alter column "wake_at" type timestamptz, alter column "created_at" type timestamptz',
      );
    await clearMarker();
    const logger = recordingLogger();
    await ensureMikroOrmDurableSchema(o, { logger });
    expect(logger.messages).toEqual([]);
  });
});

// --- MySQL: the `alter table … add` shapes and the collation conversion ---------------------------

const externalMysqlUrl = process.env.DURABLE_TEST_MYSQL_URL;
const mysqlSkipped = !externalMysqlUrl && !!process.env.SKIP_TESTCONTAINERS;
let mysqlContainer: StartedMySqlContainer | undefined;
let mysqlUrl: string | undefined;

beforeAll(async () => {
  if (mysqlSkipped) return;
  let base: string;
  if (externalMysqlUrl) base = externalMysqlUrl;
  else {
    mysqlContainer = await new MySqlContainer('mysql:8.0').start();
    // Root: the spec creates a database of its own, which the container's app user may not do.
    base = mysqlContainer.getConnectionUri(true);
  }
  // A database of its own, so it never collides with another spec sharing the server.
  const admin = await MySqlMikroORM.init({ clientUrl: base, entities: [...ENTITIES] });
  await admin.em.getConnection().execute(`drop database if exists \`${DATABASE}\``);
  await admin.em.getConnection().execute(`create database \`${DATABASE}\``);
  await admin.close(true);
  const target = new URL(base);
  target.pathname = `/${DATABASE}`;
  mysqlUrl = target.toString();
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await mysqlContainer?.stop();
});

describe.skipIf(mysqlSkipped)('ensureMikroOrmDurableSchema repair warning [real MySQL]', () => {
  let orm: MySqlMikroORM | undefined;

  afterEach(async () => {
    await orm?.close(true);
    orm = undefined;
  });

  it('is quiet when current, and lists a dropped column, a dropped index and a collation drift', async () => {
    orm = await MySqlMikroORM.init({
      clientUrl: mysqlUrl,
      entities: [...ENTITIES],
      allowGlobalContext: true,
      collate: 'utf8mb4_unicode_ci',
    });
    const connection = orm.em.getConnection();
    for (const table of ['durable_schema_meta', ...durableManagedTables()])
      await connection.execute(`drop table if exists \`${table}\``);

    const quiet = recordingLogger();
    await ensureMikroOrmDurableSchema(orm, { logger: quiet });
    await connection.execute('delete from durable_schema_meta');
    await ensureMikroOrmDurableSchema(orm, { logger: quiet });
    expect(quiet.messages).toEqual([]);

    await connection.execute('alter table `durable_workflow_runs` drop column `origin`');
    await connection.execute('drop index `durable_schedules_due_idx` on `durable_schedules`');
    await connection.execute(
      'alter table `durable_signal_waiters` convert to character set utf8mb4 collate utf8mb4_0900_ai_ci',
    );
    await connection.execute('delete from durable_schema_meta');

    const logger = recordingLogger();
    await ensureMikroOrmDurableSchema(orm, { logger });
    expect(logger.messages).toHaveLength(1);
    const [message] = logger.messages;
    expect(message).toContain('added column durable_workflow_runs.origin');
    expect(message).toContain('created index durable_schedules_due_idx on durable_schedules');
    expect(message).toContain(
      'converted durable_signal_waiters collation from utf8mb4_0900_ai_ci to utf8mb4_unicode_ci',
    );
  });

  it('upgrades second-precision datetime columns left by an older version to millisecond precision', async () => {
    orm = await MySqlMikroORM.init({
      clientUrl: mysqlUrl,
      entities: [...ENTITIES],
      allowGlobalContext: true,
    });
    const connection = orm.em.getConnection();
    for (const table of ['durable_schema_meta', ...durableManagedTables()])
      await connection.execute(`drop table if exists \`${table}\``);
    await ensureMikroOrmDurableSchema(orm, { logger: recordingLogger() });
    // The shape an older version created: plain `datetime`, which rounds to whole seconds.
    await connection.execute(
      'alter table `durable_workflow_runs` modify `wake_at` datetime null, modify `locked_until` datetime null, modify `created_at` datetime not null, modify `updated_at` datetime not null',
    );
    await connection.execute(
      'alter table `durable_buffered_events` modify `published_at` datetime not null',
    );
    await connection.execute('delete from durable_schema_meta');

    const logger = recordingLogger();
    await ensureMikroOrmDurableSchema(orm, { logger });

    const rows: Array<{ table_name: string; column_name: string; precision: number }> =
      await connection.execute(
        "select table_name as table_name, column_name as column_name, datetime_precision as `precision` from information_schema.columns where table_schema = database() and data_type = 'datetime' and table_name like 'durable\\_%'",
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => Number(row.precision) < 3)).toEqual([]);
    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain('durable_workflow_runs');
    expect(logger.messages[0]).toContain('durable_buffered_events');

    const store = new MikroOrmStateStore(orm);
    await store.bufferEvent({ name: 'evt', payload: 1, id: 'e1', publishedAt: 1_234 });
    expect((await store.listBufferedEvents('evt', 1))[0]?.publishedAt).toBe(1_234);
  });

  it('defers a column type change on a table above the row limit, and re-warns until it is applied', async () => {
    orm = await MySqlMikroORM.init({
      clientUrl: mysqlUrl,
      entities: [...ENTITIES],
      allowGlobalContext: true,
    });
    const connection = orm.em.getConnection();
    for (const table of ['durable_schema_meta', ...durableManagedTables()])
      await connection.execute(`drop table if exists \`${table}\``);
    await ensureMikroOrmDurableSchema(orm, { logger: recordingLogger() });
    await connection.execute(
      'alter table `durable_buffered_events` modify `published_at` datetime not null',
    );
    const store = new MikroOrmStateStore(orm);
    for (const id of ['a', 'b', 'c'])
      await store.bufferEvent({ name: 'evt', payload: id, id, publishedAt: 1_000 });
    await connection.execute('analyze table `durable_buffered_events`');
    await connection.execute('delete from durable_schema_meta');

    const precision = async (): Promise<number> => {
      const rows: Array<{ p: number }> = await connection.execute(
        "select datetime_precision as p from information_schema.columns where table_schema = database() and table_name = 'durable_buffered_events' and column_name = 'published_at'",
      );
      return Number(rows[0]?.p);
    };

    for (let boot = 0; boot < 2; boot++) {
      const logger = recordingLogger();
      await ensureMikroOrmDurableSchema(orm, { logger, blockingAlterRowLimit: 1 });
      expect(await precision()).toBe(0);
      expect(logger.messages).toHaveLength(1);
      expect(logger.messages[0]).toContain('did NOT apply');
      expect(logger.messages[0]).toContain('durable_buffered_events (~3 rows)');
      expect(logger.messages[0]).toMatch(/modify `published_at` datetime\(6\)/i);
    }

    await ensureMikroOrmDurableSchema(orm, { logger: recordingLogger() });
    expect(await precision()).toBe(6);
  });
});
