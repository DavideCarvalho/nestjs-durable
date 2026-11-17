import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import {
  LIFECYCLE_PENDING_INDEX,
  LIFECYCLE_PENDING_LIKE,
  LIFECYCLE_PENDING_TAG,
  ensurePgLifecyclePendingIndex,
} from './lifecycle-index';
import { TypeOrmStateStore } from './typeorm-state-store';

/**
 * The owed-lifecycle listing on a real Postgres: `ensureSchema` builds the partial index (and
 * rebuilds an invalid leftover), and the listing reads it instead of scanning the runs table. Uses
 * `DURABLE_TEST_PG_URL` when set (a dedicated database is created on that server and dropped at the
 * end), else a testcontainers `postgres:16-alpine`. Run with `pnpm test:db`.
 */

const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
const DATABASE = 'durable_lifecycle_index_typeorm';

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
}, 180_000);

afterAll(async () => {
  if (baseUrl) await admin(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`).catch(() => {});
  await container?.stop();
});

describe.skipIf(skipped)('owed-lifecycle partial index [real Postgres]', () => {
  let dataSource: DataSource | undefined;

  afterEach(async () => {
    await dataSource?.destroy();
    dataSource = undefined;
  });

  async function boot(): Promise<{ ds: DataSource; store: TypeOrmStateStore }> {
    dataSource = new DataSource({ type: 'postgres', url, entities: [...ENTITIES] });
    await dataSource.initialize();
    const store = new TypeOrmStateStore(dataSource, { schemaLogger: { warn: () => {} } });
    return { ds: dataSource, store };
  }

  const indexValid = async (ds: DataSource): Promise<boolean | undefined> =>
    (
      (await ds.query(
        'SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1',
        [LIFECYCLE_PENDING_INDEX],
      )) as Array<{ valid: boolean }>
    )[0]?.valid;

  it('the listing of marked settled runs is an index scan of the partial index', async () => {
    const { ds, store } = await boot();
    await store.ensureSchema();
    expect(await indexValid(ds)).toBe(true);
    await ds.query(
      `INSERT INTO durable_workflow_runs (id, workflow, workflow_version, status, namespace, tags, created_at, updated_at)
       SELECT 'r' || g, 'wf', '1', 'completed', 'default',
              CASE WHEN g % 1000 = 0 THEN '["${LIFECYCLE_PENDING_TAG}"]' ELSE '["other"]' END,
              now() - (g || ' seconds')::interval, now()
       FROM generate_series(1, 20000) g`,
    );
    await ds.query('ANALYZE durable_workflow_runs');
    const stats = async () =>
      (
        (await ds.query(
          `SELECT t.seq_scan::int AS seq, s.idx_scan::int AS idx FROM pg_stat_user_tables t
           JOIN pg_stat_user_indexes s ON s.relid = t.relid AND s.indexrelname = $1
           WHERE t.relname = 'durable_workflow_runs'`,
          [LIFECYCLE_PENDING_INDEX],
        )) as Array<{ seq: number; idx: number }>
      )[0] as { seq: number; idx: number };
    // The stats collector publishes on a delay: compare across a forced flush.
    await ds.query('SELECT pg_stat_force_next_flush()');
    const before = await stats();
    const runs = await store.listRuns({
      tag: LIFECYCLE_PENDING_TAG,
      statuses: ['completed', 'failed', 'cancelled', 'dead'],
      namespace: 'default',
      limit: 100,
      offset: 0,
    });
    expect(runs).toHaveLength(20);
    expect(runs.map((r) => r.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `r${(i + 1) * 1000}`),
    );
    await ds.query('SELECT pg_stat_force_next_flush()');
    const after = await stats();
    expect(after.idx - before.idx).toBe(1);
    expect(after.seq - before.seq).toBe(0);
  });

  it('rebuilds an invalid leftover of a build that died', async () => {
    const { ds, store } = await boot();
    await store.ensureSchema();
    await ds.query(`DROP INDEX "${LIFECYCLE_PENDING_INDEX}"`);
    // A concurrent unique build over duplicate values fails and leaves an INVALID index behind.
    await ds
      .query(
        `CREATE UNIQUE INDEX CONCURRENTLY "${LIFECYCLE_PENDING_INDEX}" ON durable_workflow_runs (workflow)`,
      )
      .catch(() => {});
    expect(await indexValid(ds)).toBe(false);
    await store.ensureSchema();
    expect(await indexValid(ds)).toBe(true);
    const [def] = (await ds.query(
      'SELECT pg_get_indexdef(c.oid) AS def FROM pg_class c WHERE relname = $1',
      [LIFECYCLE_PENDING_INDEX],
    )) as Array<{ def: string }>;
    expect(def?.def).toContain('(created_at) WHERE (tags ~~');
  });

  it('inside a transaction block (a migration) builds it without CONCURRENTLY', async () => {
    const { ds, store } = await boot();
    await store.ensureSchema();
    await ds.query(`DROP INDEX "${LIFECYCLE_PENDING_INDEX}"`);
    const runner = ds.createQueryRunner();
    try {
      await runner.startTransaction();
      const built = await ensurePgLifecyclePendingIndex((sql) => runner.query(sql), {
        schema: undefined,
        table: '"durable_workflow_runs"',
        createdAt: '"created_at"',
        predicate: `"tags" LIKE '${LIFECYCLE_PENDING_LIKE}'`,
      });
      await runner.commitTransaction();
      expect(built).toBe(true);
    } finally {
      await runner.release();
    }
    expect(await indexValid(ds)).toBe(true);
  });
});
