import { describe, expect, it } from 'vitest';
import { ENTITIES } from './entities';
import { durableManagedTables } from './schema';

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

  it('stays in sync with the registered entity schemas', () => {
    const entityTableNames = ENTITIES.map((entity) => entity.options.tableName).sort();
    expect(durableManagedTables().sort()).toEqual(entityTableNames);
  });
});
