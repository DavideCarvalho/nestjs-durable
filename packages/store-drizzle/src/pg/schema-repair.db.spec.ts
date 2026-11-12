import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MissingTenantColumnsError } from '../tenant-columns';
import { ensureDrizzlePgDurableSchema } from './ddl';
import { DrizzlePgStateStore } from './drizzle-pg-state-store';
import { durablePgManagedTables } from './schema';

/**
 * The schema-repair warning against a real Postgres: the DDL is all `IF NOT EXISTS`, so what is
 * reported comes from the catalog probes run before it. Uses `DURABLE_TEST_PG_URL` when set (a
 * dedicated database is created on that server and dropped at the end), else a testcontainers
 * `postgres:16-alpine`. Skips without Docker or with `SKIP_TESTCONTAINERS`. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const externalUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
const DATABASE = 'durable_schema_repair_drizzle';

let container: StartedPostgreSqlContainer | undefined;
let baseUrl: string | undefined;
let pool: pg.Pool | undefined;

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
  pool = new pg.Pool({ connectionString: target.toString(), max: 4 });
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await pool?.end();
  if (baseUrl) await admin(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`).catch(() => {});
  await container?.stop();
});

function recordingLogger(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}

describe.skipIf(skipped)('ensureDrizzlePgDurableSchema repair warning [real Postgres]', () => {
  beforeEach(async () => {
    for (const table of durablePgManagedTables())
      await pool?.query(`DROP TABLE IF EXISTS "${table}"`);
  });

  it('logs nothing on a fresh install or on a schema that is already current', async () => {
    const db = drizzle(pool as pg.Pool);
    const logger = recordingLogger();
    await ensureDrizzlePgDurableSchema(db, { logger });
    await ensureDrizzlePgDurableSchema(db, { logger });
    expect(logger.messages).toEqual([]);
  });

  it('logs ONE warning listing a dropped index and a dropped table', async () => {
    const db = drizzle(pool as pg.Pool);
    await ensureDrizzlePgDurableSchema(db, { logger: recordingLogger() });
    await pool?.query('DROP INDEX "durable_runs_tags_gin_idx"');
    await pool?.query('DROP TABLE "durable_schedules"');

    const logger = recordingLogger();
    await new DrizzlePgStateStore(db, { schemaLogger: logger }).ensureSchema();

    expect(logger.messages).toHaveLength(1);
    expect(logger.messages[0]).toContain(
      '[nestjs-durable] store-drizzle repaired the durable schema at boot: created table durable_schedules; created index durable_runs_tags_gin_idx on durable_workflow_runs.',
    );
    // The new table's own index came with it, so it is not listed separately.
    expect(logger.messages[0]).not.toContain('durable_schedules_due_idx');

    const after = recordingLogger();
    await ensureDrizzlePgDurableSchema(db, { logger: after });
    expect(after.messages).toEqual([]);
  });

  it('keeps the scoped store logger through withScope', async () => {
    const db = drizzle(pool as pg.Pool);
    await ensureDrizzlePgDurableSchema(db, { logger: recordingLogger() });
    await pool?.query('DROP INDEX "durable_schedules_due_idx"');

    const logger = recordingLogger();
    await new DrizzlePgStateStore(db, { schemaLogger: logger })
      .withScope({ namespace: 'tenant-a' })
      .ensureSchema();

    expect(logger.messages).toEqual([
      expect.stringContaining('created index durable_schedules_due_idx on durable_schedules'),
    ]);
  });
});

describe.skipIf(skipped)('a Postgres database without the tenancy columns (autoSchema off)', () => {
  beforeEach(async () => {
    for (const table of durablePgManagedTables())
      await pool?.query(`DROP TABLE IF EXISTS "${table}"`);
  });

  it('fails boot recovery with the exact migration, and autoSchema repairs it', async () => {
    const db = drizzle(pool as pg.Pool);
    await ensureDrizzlePgDurableSchema(db, { logger: recordingLogger() });
    for (const table of ['durable_workflow_runs', 'durable_schedules']) {
      await pool?.query(
        `ALTER TABLE "${table}" DROP COLUMN "tenant_id", DROP COLUMN "tenant_kind"`,
      );
    }
    const store = new DrizzlePgStateStore(db);

    const err = await store.listOrphanedRuns(Date.now(), 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingTenantColumnsError);
    const message = (err as Error).message;
    expect(message).toContain(
      'ALTER TABLE "durable_workflow_runs" ADD COLUMN IF NOT EXISTS "tenant_id" text;',
    );
    expect(message).toContain(
      'CREATE INDEX IF NOT EXISTS "durable_schedules_tenant_idx" ON "durable_schedules" USING btree ("tenant_id");',
    );
    expect(message).toContain('autoSchema');
    await expect(store.listSchedules({ dueBy: Date.now() })).rejects.toBeInstanceOf(
      MissingTenantColumnsError,
    );
    await expect(
      store.claimPendingRuns(5, 'me', Date.now() + 1000, Date.now()),
    ).rejects.toBeInstanceOf(MissingTenantColumnsError);

    // The statements in the message are what fixes it.
    for (const line of message.split('\n').filter((l) => /^\s+(ALTER|CREATE)/.test(l))) {
      await pool?.query(line.trim());
    }
    expect(await store.listOrphanedRuns(Date.now(), 10)).toEqual([]);
  });
});
