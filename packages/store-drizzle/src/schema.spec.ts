import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { durableManagedTables, durableSchema } from './schema';

describe('durableManagedTables', () => {
  it('returns the eight durable table names', () => {
    expect(durableManagedTables().sort()).toEqual([
      'durable_buffered_events',
      'durable_buffered_signals',
      'durable_run_attributes',
      'durable_schedules',
      'durable_signal_ids',
      'durable_signal_waiters',
      'durable_step_checkpoints',
      'durable_workflow_runs',
    ]);
  });

  it('stays in sync with the registered drizzle tables', () => {
    const schemaTableNames = Object.values(durableSchema)
      .map((table) => getTableName(table))
      .sort();
    expect(durableManagedTables().sort()).toEqual(schemaTableNames);
  });
});

describe('schema option on SQLite', () => {
  it('fails at construction: SQLite has no schemas', async () => {
    const { DrizzleStateStore } = await import('./drizzle-state-store');
    const Database = (await import('better-sqlite3')).default;
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const db = drizzle(new Database(':memory:'));
    expect(() => new DrizzleStateStore(db, { schema: 'durable' })).toThrow(
      /schema option .* is not supported on SQLite/,
    );
  });
});
