import { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { LIFECYCLE_PENDING_INDEX, LIFECYCLE_PENDING_TAG } from './lifecycle-index';
import { MikroOrmStateStore } from './mikro-orm-state-store';
import { durableManagedTables, ensureMikroOrmDurableSchema } from './schema';

/**
 * The owed-lifecycle listing on a real Postgres: the schema heal builds the partial index (and an
 * upgraded database whose fingerprint predates it gets it on the next boot), and the listing reads
 * it instead of scanning the runs table. Uses `DURABLE_TEST_PG_URL` when set (a dedicated database is
 * created on that server and dropped at the end), else a testcontainers `postgres:16-alpine`. Run
 * with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
const DATABASE = 'durable_lifecycle_index_mikro_orm';

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

describe.skipIf(skipped)('owed-lifecycle partial index [real Postgres]', () => {
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

  afterEach(async () => {
    await orm?.close(true);
    orm = undefined;
  });

  const indexValid = async (o: PostgresMikroORM): Promise<boolean | undefined> =>
    (
      (await o.em
        .getConnection()
        .execute(
          `select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = '${LIFECYCLE_PENDING_INDEX}'`,
        )) as Array<{ valid: boolean }>
    )[0]?.valid;

  it('the listing of marked settled runs is an index scan of the partial index', async () => {
    const o = await boot();
    const logger = { warn: () => {} };
    await ensureMikroOrmDurableSchema(o, { logger });
    expect(await indexValid(o)).toBe(true);
    const conn = o.em.getConnection();
    await conn.execute(
      `insert into durable_workflow_runs (id, workflow, workflow_version, status, namespace, tags, created_at, updated_at)
       select 'r' || g, 'wf', '1', 'completed', 'default',
              case when g % 1000 = 0 then '["${LIFECYCLE_PENDING_TAG}"]'::jsonb else '["other"]'::jsonb end,
              now() - (g || ' seconds')::interval, now()
       from generate_series(1, 20000) g`,
    );
    await conn.execute('analyze durable_workflow_runs');
    const stats = async () =>
      (
        (await conn.execute(
          `select t.seq_scan::int as seq, s.idx_scan::int as idx from pg_stat_user_tables t
           join pg_stat_user_indexes s on s.relid = t.relid and s.indexrelname = '${LIFECYCLE_PENDING_INDEX}'
           where t.relname = 'durable_workflow_runs'`,
        )) as Array<{ seq: number; idx: number }>
      )[0] as { seq: number; idx: number };
    await conn.execute('select pg_stat_force_next_flush()');
    const before = await stats();
    const store = new MikroOrmStateStore(o);
    const runs = await store.listRuns({
      tag: LIFECYCLE_PENDING_TAG,
      statuses: ['completed', 'failed', 'cancelled', 'dead'],
      namespace: 'default',
      limit: 100,
      offset: 0,
    });
    expect(runs).toHaveLength(20);
    await conn.execute('select pg_stat_force_next_flush()');
    const after = await stats();
    expect(after.idx - before.idx).toBe(1);
    expect(after.seq - before.seq).toBe(0);
  });

  it('a database healed before the index existed gets it on the next boot', async () => {
    const o = await boot();
    const logger = { warn: (m: string) => messages.push(m) };
    const messages: string[] = [];
    await ensureMikroOrmDurableSchema(o, { logger });
    await o.em.getConnection().execute(`drop index "${LIFECYCLE_PENDING_INDEX}"`);
    // An older version's fingerprint: everything else matches, the revision does not.
    await o.em.getConnection().execute(`update durable_schema_meta set fingerprint = 'older'`);
    await ensureMikroOrmDurableSchema(o, { logger });
    expect(await indexValid(o)).toBe(true);
    expect(messages.join('\n')).toContain(`created index ${LIFECYCLE_PENDING_INDEX}`);
  });
});
