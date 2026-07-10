import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { durableManagedTables } from './schema';

describe('durableManagedTables', () => {
  it('returns the five durable table names', () => {
    expect(durableManagedTables().sort()).toEqual([
      'durable_buffered_signals',
      'durable_run_attributes',
      'durable_signal_waiters',
      'durable_step_checkpoints',
      'durable_workflow_runs',
    ]);
  });

  it('stays in sync with the @@map(...) table names in prisma/schema.prisma', () => {
    const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');
    const mappedTableNames = [...schema.matchAll(/@@map\("([^"]+)"\)/g)]
      .map(([, tableName]) => tableName)
      .sort();
    expect(durableManagedTables().sort()).toEqual(mappedTableNames);
  });
});
