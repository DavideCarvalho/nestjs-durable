import {
  DURABLE_CANONICAL_COLUMNS,
  assertDurableColumns,
  preserveColumnExpectation,
} from '@dudousxd/nestjs-durable-testing';
import { DataSource } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { type DurableColumnNaming, durableEntities } from './entities';

/**
 * Cross-adapter column contract for the TypeORM store. The durable tables are adapter-agnostic, so
 * the physical columns must match {@link DURABLE_CANONICAL_COLUMNS} (canonical `snake_case`) — this is
 * the guard the project lacked when the TypeORM and MikroORM adapters silently diverged (one keeping
 * verbatim camelCase, the other defaulting to its ORM's naming strategy), breaking a store swap with
 * a runtime "Unknown column" error. The MikroORM, Prisma and Drizzle adapters each had this spec;
 * TypeORM — one of the two adapters the incident was actually about — did not, so its `col()` naming
 * was the only one the contract never checked.
 *
 * The columns are read back off the RESOLVED `DataSource` metadata, not off the `EntitySchema`
 * options this package writes. That distinction is the whole point: TypeORM's naming strategy gets a
 * say in `columnName(propertyName, customName)`, so reading the options back would only confirm that
 * `entities.ts` says what `entities.ts` says. Asserting `databaseName` proves what the driver will
 * actually put in the SQL.
 */

let dataSource: DataSource | undefined;

afterEach(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
  dataSource = undefined;
});

/** Init a DataSource with the durable entities under `naming` and return a (table, property) → column resolver. */
async function columnResolver(naming?: DurableColumnNaming) {
  dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    // `synchronize: false` — this asserts the mapping, not the DDL; `schema.spec.ts` covers the DDL.
    synchronize: false,
    entities: durableEntities(naming ? { naming } : {}),
  });
  await dataSource.initialize();

  // tableName -> (property name -> physical column name)
  const byTable = new Map<string, Map<string, string>>();
  for (const meta of dataSource.entityMetadatas) {
    const columns = new Map<string, string>();
    for (const column of meta.columns) columns.set(column.propertyName, column.databaseName);
    byTable.set(meta.tableName, columns);
  }
  return (table: string, property: string) => byTable.get(table)?.get(property);
}

describe('durableEntities column naming', () => {
  it('defaults to the canonical snake_case columns', async () => {
    const resolve = await columnResolver();
    expect(assertDurableColumns(resolve)).toEqual([]);
  });

  it('maps every property to the canonical snake_case column under naming: "snake_case"', async () => {
    const resolve = await columnResolver('snake_case');
    expect(assertDurableColumns(resolve)).toEqual([]);
  });

  it('preserves verbatim camelCase property names under naming: "preserve"', async () => {
    const resolve = await columnResolver('preserve');
    expect(assertDurableColumns(resolve, preserveColumnExpectation())).toEqual([]);
  });

  it('accepts a custom mapping function', async () => {
    const resolve = await columnResolver((property) => `c_${property}`);
    expect(resolve('durable_workflow_runs', 'createdAt')).toBe('c_createdAt');
    expect(resolve('durable_run_attributes', 'numValue')).toBe('c_numValue');
  });
});
