import { DURABLE_CANONICAL_COLUMNS, assertDurableColumns } from '@dudousxd/nestjs-durable-testing';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { durableManagedTables } from '../schema';
import { DURABLE_PG_DDL } from './ddl';
import { DrizzlePgStateStore } from './drizzle-pg-state-store';
import { toDrizzleSql } from './executor';
import { durablePgManagedTables, durablePgSchema } from './schema';

// Unit-level (no database) pins for the Postgres schema. The real-engine parity check — the shipped
// DDL against these pgTable definitions — lives in `drizzle-pg-state-store.db.spec.ts`.

describe('Drizzle Postgres durable schema', () => {
  it('maps every property to the canonical cross-adapter snake_case column', () => {
    const byTable = new Map<string, Map<string, string>>();
    for (const table of Object.values(durablePgSchema)) {
      byTable.set(
        getTableName(table),
        new Map(Object.entries(getTableColumns(table)).map(([p, c]) => [p, c.name])),
      );
    }
    expect(assertDurableColumns((table, property) => byTable.get(table)?.get(property))).toEqual(
      [],
    );
    expect(Object.keys(DURABLE_CANONICAL_COLUMNS).sort()).toEqual(durablePgManagedTables().sort());
  });

  it('owns the same seven tables as the SQLite schema', () => {
    expect(durablePgManagedTables().sort()).toEqual(durableManagedTables().sort());
  });

  it('ships DDL for every table and index the pgTables declare', () => {
    const ddl = DURABLE_PG_DDL.join('\n');
    for (const table of Object.values(durablePgSchema)) {
      const config = getTableConfig(table);
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${config.name}"`);
      for (const column of config.columns) expect(ddl).toContain(`"${column.name}"`);
      for (const index of config.indexes)
        expect(ddl).toContain(`CREATE INDEX IF NOT EXISTS "${index.config.name}"`);
    }
    // Every statement is re-runnable (auto-schema runs them on every boot).
    for (const statement of DURABLE_PG_DDL) expect(statement).toMatch(/ IF NOT EXISTS /);
  });

  it('accepts a drizzle db built with or without a relational schema', () => {
    const pool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/none' });
    expect(new DrizzlePgStateStore(drizzle(pool))).toBeInstanceOf(DrizzlePgStateStore);
    expect(
      new DrizzlePgStateStore(drizzle(pool, { schema: { ...durablePgSchema } })),
    ).toBeInstanceOf(DrizzlePgStateStore);
    void pool.end();
  });
});

describe('toDrizzleSql', () => {
  it('turns $n placeholders into bound params, reusing a param referenced twice', () => {
    const query = toDrizzleSql('SELECT * FROM t WHERE a = $1 AND b = $2 OR c = $1', ['x', 7]);
    const pgDialect = new PgDialect();
    const { sql, params } = pgDialect.sqlToQuery(query);
    expect(sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $2 OR c = $3');
    expect(params).toEqual(['x', 7, 'x']);
  });

  it('rejects a placeholder with no parameter', () => {
    expect(() => toDrizzleSql('SELECT $2', ['only-one'])).toThrow(/\$2/);
  });
});
