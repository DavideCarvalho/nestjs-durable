import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { ensureTypeOrmDurableSchema } from './schema';
import { TypeOrmStateStore } from './typeorm-state-store';

/**
 * The schema-repair warning against a real Postgres: the catalog probes (`information_schema`) and
 * the best-effort `CREATE INDEX` decide what is reported. Uses `DURABLE_TEST_PG_URL` when set (a
 * dedicated database is created on that server and dropped at the end), else a testcontainers
 * `postgres:16-alpine`; the MySQL case likewise uses `DURABLE_TEST_MYSQL_URL` or a testcontainers
 * `mysql:8.0`. Skips without Docker or with `SKIP_TESTCONTAINERS`. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
const DATABASE = 'durable_schema_repair_typeorm';

let container: StartedPostgreSqlContainer | undefined;
let baseUrl: string | undefined;
let url: string | undefined;

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  if (skipped) return;
  if (externalUrl) baseUrl = externalUrl;
  else {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    baseUrl = container.getConnectionUri();
  }
  await admin(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  await admin(`CREATE DATABASE "${DATABASE}"`);
  const target = new URL(baseUrl);
  target.pathname = `/${DATABASE}`;
  url = target.toString();
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  if (baseUrl) await admin(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`).catch(() => {});
  await container?.stop();
});

function recordingLogger(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}

describe.skipIf(skipped)('ensureTypeOrmDurableSchema repair warning [real Postgres]', () => {
  let dataSource: DataSource | undefined;

  async function boot(): Promise<DataSource> {
    dataSource = new DataSource({ type: 'postgres', url, entities: [...ENTITIES] });
    await dataSource.initialize();
    for (const table of ['durable_schema_meta', ...ENTITIES.map((e) => e.options.tableName)])
      await dataSource.query(`DROP TABLE IF EXISTS "${table}"`);
    return dataSource;
  }

  afterEach(async () => {
    await dataSource?.destroy();
    dataSource = undefined;
  });

  it('logs nothing on a fresh install or on a schema that is already current', async () => {
    const ds = await boot();
    const logger = recordingLogger();
    await ensureTypeOrmDurableSchema(ds, { logger });
    await ensureTypeOrmDurableSchema(ds, { logger });
    expect(logger.messages).toEqual([]);
  });

  it('logs ONE warning listing a dropped column, a dropped index and a dropped table', async () => {
    const ds = await boot();
    await ensureTypeOrmDurableSchema(ds, { logger: recordingLogger() });
    await ds.query('ALTER TABLE "durable_workflow_runs" DROP COLUMN "origin"');
    await ds.query('DROP INDEX "durable_runs_namespace_status_idx"');
    await ds.query('DROP TABLE "durable_schedules"');

    const logger = recordingLogger();
    await new TypeOrmStateStore(ds, { schemaLogger: logger }).ensureSchema();

    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain(
      '[nestjs-durable] store-typeorm repaired the durable schema at boot: created table durable_schedules; added column durable_workflow_runs.origin; created index durable_runs_namespace_status_idx on durable_workflow_runs.',
    );

    const after = recordingLogger();
    await ensureTypeOrmDurableSchema(ds, { logger: after });
    expect(after.messages).toEqual([]);
  });
});

// --- MySQL: the JSON-blob widen (`text` → `longtext`) is reported only when it ran -----------------

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
  const admin = new DataSource({ type: 'mysql', url: base });
  await admin.initialize();
  await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${DATABASE}\``);
  await admin.destroy();
  const target = new URL(base);
  target.pathname = `/${DATABASE}`;
  mysqlUrl = target.toString();
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await mysqlContainer?.stop();
});

describe.skipIf(mysqlSkipped)('ensureTypeOrmDurableSchema repair warning [real MySQL]', () => {
  let dataSource: DataSource | undefined;

  afterEach(async () => {
    await dataSource?.destroy();
    dataSource = undefined;
  });

  it('is quiet when current, and lists a narrowed JSON column and a dropped index', async () => {
    dataSource = new DataSource({ type: 'mysql', url: mysqlUrl, entities: [...ENTITIES] });
    await dataSource.initialize();
    for (const table of ENTITIES.map((e) => e.options.tableName))
      await dataSource.query(`DROP TABLE IF EXISTS \`${table}\``);

    const quiet = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger: quiet });
    await ensureTypeOrmDurableSchema(dataSource, { logger: quiet });
    expect(quiet.messages).toEqual([]);

    await dataSource.query('ALTER TABLE `durable_step_checkpoints` MODIFY COLUMN `events` text');
    await dataSource.query('DROP INDEX `durable_runs_status_idx` ON `durable_workflow_runs`');

    const logger = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger });
    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain(
      'at boot: widened durable_step_checkpoints.events from text to longtext; created index durable_runs_status_idx on durable_workflow_runs.',
    );

    const after = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger: after });
    expect(after.messages).toEqual([]);
  });
  async function freshMysql(): Promise<DataSource> {
    const ds = new DataSource({ type: 'mysql', url: mysqlUrl, entities: [...ENTITIES] });
    await ds.initialize();
    for (const table of ENTITIES.map((e) => e.options.tableName))
      await ds.query(`DROP TABLE IF EXISTS \`${table}\``);
    return ds;
  }

  async function datetimePrecisions(ds: DataSource): Promise<Record<string, number>> {
    const rows = (await ds.query(
      "SELECT table_name AS t, column_name AS c, datetime_precision AS p FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type = 'datetime' AND table_name LIKE 'durable\\_%'",
    )) as Array<{ t: string; c: string; p: number }>;
    return Object.fromEntries(rows.map((r) => [`${r.t}.${r.c}`, Number(r.p)]));
  }

  it('creates every timestamp column with sub-second precision', async () => {
    dataSource = await freshMysql();
    await ensureTypeOrmDurableSchema(dataSource, { logger: recordingLogger() });
    const precisions = await datetimePrecisions(dataSource);
    expect(Object.keys(precisions)).toHaveLength(11);
    expect(Object.values(precisions).every((p) => p === 6)).toBe(true);
  });

  it('upgrades second-precision timestamp columns an older version created, keeping nullability', async () => {
    dataSource = await freshMysql();
    await ensureTypeOrmDurableSchema(dataSource, { logger: recordingLogger() });
    await dataSource.query(
      'ALTER TABLE `durable_workflow_runs` MODIFY `wake_at` datetime NULL, MODIFY `created_at` datetime NOT NULL',
    );
    await dataSource.query(
      'ALTER TABLE `durable_buffered_events` MODIFY `published_at` datetime NOT NULL',
    );

    const logger = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger });
    expect(Object.values(await datetimePrecisions(dataSource)).every((p) => p === 6)).toBe(true);
    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain(
      'raised durable_workflow_runs.wake_at, durable_workflow_runs.created_at to datetime(6)',
    );
    expect(logger.messages[0]).toContain(
      'raised durable_buffered_events.published_at to datetime(6)',
    );
    const nullability = (await dataSource.query(
      "SELECT column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'durable_workflow_runs' AND column_name IN ('wake_at', 'created_at') ORDER BY column_name",
    )) as Array<{ c: string; n: string }>;
    expect(nullability).toEqual([
      { c: 'created_at', n: 'NO' },
      { c: 'wake_at', n: 'YES' },
    ]);

    const after = recordingLogger();
    await ensureTypeOrmDurableSchema(dataSource, { logger: after });
    expect(after.messages).toEqual([]);
  });

  it('defers the upgrade on a table above the row limit, re-warning on every boot', async () => {
    dataSource = await freshMysql();
    await ensureTypeOrmDurableSchema(dataSource, { logger: recordingLogger() });
    await dataSource.query(
      'ALTER TABLE `durable_buffered_events` MODIFY `published_at` datetime NOT NULL',
    );
    for (const id of ['a', 'b', 'c'])
      await dataSource.query(
        "INSERT INTO `durable_buffered_events` (`id`, `name`, `payload`, `published_at`) VALUES (?, 'evt', '1', NOW())",
        [id],
      );
    await dataSource.query('ANALYZE TABLE `durable_buffered_events`');

    for (let boot = 0; boot < 2; boot++) {
      const logger = recordingLogger();
      await ensureTypeOrmDurableSchema(dataSource, { logger, blockingAlterRowLimit: 1 });
      expect((await datetimePrecisions(dataSource))['durable_buffered_events.published_at']).toBe(
        0,
      );
      expect(logger.messages).toHaveLength(1);
      expect(logger.messages[0]).toContain('did NOT apply');
      expect(logger.messages[0]).toContain('-- durable_buffered_events, ~3 rows');
    }

    await ensureTypeOrmDurableSchema(dataSource, { logger: recordingLogger() });
    expect((await datetimePrecisions(dataSource))['durable_buffered_events.published_at']).toBe(6);
  });
});
