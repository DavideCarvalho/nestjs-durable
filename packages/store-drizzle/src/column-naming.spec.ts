import { DURABLE_CANONICAL_COLUMNS, assertDurableColumns } from '@dudousxd/nestjs-durable-testing';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { durableSchema } from './schema';

/**
 * Cross-adapter column contract for the Drizzle store. The durable tables are adapter-agnostic, so
 * the physical columns must match {@link DURABLE_CANONICAL_COLUMNS} (canonical `snake_case`). Drizzle
 * is the reference — its schema already pins explicit snake_case names — so this asserts it stays
 * the canonical baseline the other adapters are pinned against.
 */
describe('Drizzle durable column contract', () => {
  it('maps every property to the canonical snake_case column', () => {
    // tableName -> (drizzle property name -> physical column name)
    const byTable = new Map<string, Map<string, string>>();
    for (const table of Object.values(durableSchema)) {
      const props = new Map<string, string>();
      for (const [property, column] of Object.entries(getTableColumns(table))) {
        props.set(property, column.name);
      }
      byTable.set(getTableName(table), props);
    }

    const resolve = (table: string, property: string) => byTable.get(table)?.get(property);
    expect(assertDurableColumns(resolve)).toEqual([]);
  });
});
