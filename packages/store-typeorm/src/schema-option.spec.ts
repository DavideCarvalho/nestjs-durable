import { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { ENTITIES, durableEntities } from './entities';
import { TypeOrmStateStore } from './typeorm-state-store';

describe('TypeORM schema option (validation)', () => {
  it('fails on SQLite, and when the store and the entities disagree', async () => {
    const sqlite = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: durableEntities({ schema: 'durable' }),
    });
    // TypeORM reads a SQLite table's `database` as an attached database file: boot fails there.
    await expect(sqlite.initialize()).rejects.toThrow();

    const plain = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ENTITIES,
    });
    await plain.initialize();
    expect(() => new TypeOrmStateStore(plain, { schema: 'durable' })).toThrow(
      /not supported on SQLite/,
    );
    await plain.destroy();
    expect(() => durableEntities({ schema: 'no-dashes' })).toThrow(/invalid schema/);
  });
});
