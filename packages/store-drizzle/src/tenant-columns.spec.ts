import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DrizzleStateStore } from './drizzle-state-store';
import { durableSchema } from './schema';
import { MissingTenantColumnsError, isMissingTenantColumn } from './tenant-columns';

/** The run and schedule tables as a database migrated before the tenancy columns has them. */
const PRE_TENANCY_DDL = `
CREATE TABLE durable_workflow_runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, workflow_version TEXT NOT NULL, status TEXT NOT NULL,
  input TEXT, output TEXT, error TEXT, wake_at INTEGER, locked_by TEXT, locked_until INTEGER,
  awaiting_decision_task_id TEXT,
  recovery_attempts INTEGER, tags TEXT, search_attributes TEXT, priority INTEGER,
  namespace TEXT NOT NULL DEFAULT 'default', origin TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE durable_schedules (
  id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default', workflow TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0, next_fire_at INTEGER, tags TEXT, spec TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;

describe('a database without the tenancy columns', () => {
  function unmigrated() {
    const sqlite = new Database(':memory:');
    sqlite.exec(PRE_TENANCY_DDL);
    return new DrizzleStateStore(drizzle(sqlite, { schema: durableSchema }));
  }

  it('fails boot recovery with the migration to run', async () => {
    const store = unmigrated();
    const err = await store.listOrphanedRuns(Date.now(), 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingTenantColumnsError);
    const message = (err as Error).message;
    expect(message).toContain('ALTER TABLE durable_workflow_runs ADD COLUMN tenant_id TEXT;');
    expect(message).toContain('ALTER TABLE durable_schedules ADD COLUMN tenant_kind TEXT;');
    expect(message).toContain(
      'CREATE INDEX IF NOT EXISTS durable_workflow_runs_tenant_idx ON durable_workflow_runs (tenant_id, created_at);',
    );
    expect(message).toContain('drizzle-kit generate');
    expect(message).not.toContain('autoSchema');
  });

  it('fails the pollers and the schedule scan the same way', async () => {
    const store = unmigrated();
    await expect(store.listIncompleteRuns()).rejects.toBeInstanceOf(MissingTenantColumnsError);
    await expect(store.listPendingRuns(10)).rejects.toBeInstanceOf(MissingTenantColumnsError);
    await expect(store.listDueTimers(Date.now())).rejects.toBeInstanceOf(MissingTenantColumnsError);
    await expect(store.listSchedules({ dueBy: Date.now() })).rejects.toBeInstanceOf(
      MissingTenantColumnsError,
    );
  });
});

describe('isMissingTenantColumn', () => {
  it('matches Postgres 42703 and SQLite "no such column", wrapped or not', () => {
    const pg = Object.assign(new Error('column "tenant_id" does not exist'), { code: '42703' });
    expect(isMissingTenantColumn(pg)).toBe(true);
    expect(isMissingTenantColumn(new Error('Failed query: select …', { cause: pg }))).toBe(true);
    expect(isMissingTenantColumn(new Error('SQLITE_ERROR: no such column: tenant_kind'))).toBe(
      true,
    );
  });

  it('ignores other missing columns and other errors', () => {
    const other = Object.assign(new Error('column "origin" does not exist'), { code: '42703' });
    expect(isMissingTenantColumn(other)).toBe(false);
    expect(isMissingTenantColumn(new Error('duplicate key value violates "tenant_id"'))).toBe(
      false,
    );
    expect(isMissingTenantColumn(undefined)).toBe(false);
  });
});
