import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { durableManagedTables, durableSchema } from './schema';

describe('durableManagedTables', () => {
  it('returns the six durable table names', () => {
    expect(durableManagedTables().sort()).toEqual([
      'durable_buffered_events',
      'durable_buffered_signals',
      'durable_run_attributes',
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
