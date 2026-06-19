import { assertDurableColumns } from '@dudousxd/nestjs-durable-testing';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/client';

/**
 * Cross-adapter column contract for the Prisma store. The durable tables are adapter-agnostic, so the
 * physical columns must match {@link DURABLE_CANONICAL_COLUMNS} (canonical `snake_case`) — this is the
 * guard the project lacked when the store adapters silently diverged (the MikroORM adapter went
 * snake_case while TypeORM/Prisma kept verbatim camelCase), breaking a store swap with a runtime
 * "Unknown column" error.
 *
 * Unlike the MikroORM/TypeORM adapters there is NO runtime naming choice here: Prisma's schema is
 * static codegen, so the columns are pinned to snake_case via `@map`/`@@map` in `prisma/schema.prisma`
 * (mirrored in the test schemas). We read the resolved physical columns straight from the generated
 * client's DMMF — `dbName` is the `@map` value (falling back to the field `name` when unmapped), and
 * each model's `dbName` is its `@@map` table name.
 */

/** Index the DMMF models by their `@@map` table name → (property → physical column). */
const columnsByTable = new Map<string, Map<string, string>>();
for (const model of Prisma.dmmf.datamodel.models) {
  const table = model.dbName ?? model.name;
  const columns = new Map<string, string>();
  for (const field of model.fields) {
    // Relation fields (e.g. `attributes`, `run`) have no physical column — skip them.
    if (field.relationName) continue;
    columns.set(field.name, field.dbName ?? field.name);
  }
  columnsByTable.set(table, columns);
}

function resolveColumn(table: string, property: string): string | undefined {
  return columnsByTable.get(table)?.get(property);
}

describe('PrismaStateStore column naming', () => {
  it('maps every durable column to the canonical snake_case contract', () => {
    expect(assertDurableColumns(resolveColumn)).toEqual([]);
  });
});
