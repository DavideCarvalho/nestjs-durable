import type { MikroORM } from '@mikro-orm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureMikroOrmDurableSchema } from './schema';

/** Minimal ORM double: a fixed update-schema SQL string + a connection whose `execute` we control.
 * Platform defaults to a non-MySQL name so collation alignment is a no-op unless a test opts in. */
function makeOrm(
  sql: string,
  execute: (statement: string, params?: unknown[]) => Promise<unknown>,
  opts: { platform?: string; collate?: string } = {},
): MikroORM {
  const platform = opts.platform ?? 'SqlitePlatform';
  return {
    schema: { getUpdateSchemaSQL: async () => sql },
    em: {
      getConnection: () => ({ execute }),
      getPlatform: () => ({ constructor: { name: platform } }),
    },
    config: { get: (key: string) => (key === 'collate' ? opts.collate : undefined) },
  } as unknown as MikroORM;
}

describe('ensureMikroOrmDurableSchema resilience', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips a failing type-alignment (modify) statement instead of crashing boot', async () => {
    // longtext → json conversion fails on legacy/invalid data; the add-column must still run.
    const sql = [
      'alter table `durable_step_checkpoints` add column `foo` varchar(255) null',
      'alter table `durable_step_checkpoints` modify `events` json null',
    ].join(';\n');
    const ran: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      if (/\bmodify\b/i.test(statement)) {
        throw new Error('ER_INVALID_JSON_TEXT: Missing a closing quotation mark');
      }
      ran.push(statement);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureMikroOrmDurableSchema(makeOrm(sql, execute))).resolves.toBeUndefined();

    // The required add-column ran; the failed modify was swallowed with a warning.
    expect(ran.some((s) => /add column/i.test(s))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rethrows when required structure (add column / create table) fails', async () => {
    const sql = 'alter table `durable_workflow_runs` add column `bar` varchar(255) null';
    const execute = async () => {
      throw new Error('boom');
    };

    await expect(ensureMikroOrmDurableSchema(makeOrm(sql, execute))).rejects.toThrow('boom');
  });

  it('only touches durable tables (ignores statements for other tables)', async () => {
    const sql = [
      'alter table `some_app_table` modify `col` json null',
      'alter table `durable_signal_waiters` add column `seq` int null',
    ].join(';\n');
    const ran: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      ran.push(statement);
    });

    await ensureMikroOrmDurableSchema(makeOrm(sql, execute));

    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain('durable_signal_waiters');
  });

  it('applies a standalone `create index ... on durable_*` (postgres/sqlite index form)', async () => {
    // Adding an index to an existing table emits `create index` on Postgres/SQLite (vs `alter table
    // add index` on MySQL). Both must reach our durable tables; an index on a non-durable table must not.
    const sql = [
      'create index `durable_workflow_runs_status_wake_at_idx` on `durable_workflow_runs` (`status`, `wake_at`)',
      'create index `some_app_idx` on `some_app_table` (`col`)',
    ].join(';\n');
    const ran: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      ran.push(statement);
    });

    await ensureMikroOrmDurableSchema(makeOrm(sql, execute));

    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain('durable_workflow_runs_status_wake_at_idx');
  });

  it('rethrows when a required `create index` on a durable table fails', async () => {
    const sql =
      'create index `durable_workflow_runs_workflow_status_idx` on `durable_workflow_runs` (`workflow`, `status`)';
    const execute = async () => {
      throw new Error('idx boom');
    };

    await expect(ensureMikroOrmDurableSchema(makeOrm(sql, execute))).rejects.toThrow('idx boom');
  });
});

describe('ensureMikroOrmDurableSchema collation alignment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('converts durable tables whose collation differs from the configured collate (mysql)', async () => {
    const converts: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      if (/information_schema/i.test(statement)) {
        return [{ collation: 'utf8mb4_0900_ai_ci' }];
      }
      converts.push(statement);
      return undefined;
    });

    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, { platform: 'MySqlPlatform', collate: 'utf8mb4_unicode_ci' }),
    );

    // One CONVERT per durable table, deriving the charset from the collation prefix.
    expect(converts).toHaveLength(5);
    expect(
      converts.every((s) => /convert to character set utf8mb4 collate utf8mb4_unicode_ci/i.test(s)),
    ).toBe(true);
    expect(converts.some((s) => s.includes('durable_workflow_runs'))).toBe(true);
  });

  it('skips tables already at the configured collation', async () => {
    const converts: string[] = [];
    const execute = vi.fn(async (statement: string) => {
      if (/information_schema/i.test(statement)) {
        return [{ collation: 'utf8mb4_unicode_ci' }];
      }
      converts.push(statement);
      return undefined;
    });

    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, { platform: 'MySqlPlatform', collate: 'utf8mb4_unicode_ci' }),
    );

    expect(converts).toHaveLength(0);
  });

  it('is a no-op on non-mysql platforms', async () => {
    const execute = vi.fn(async () => undefined);
    await ensureMikroOrmDurableSchema(
      makeOrm('', execute, { platform: 'PostgreSqlPlatform', collate: 'whatever' }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('is a no-op when no collate is configured', async () => {
    const execute = vi.fn(async () => undefined);
    await ensureMikroOrmDurableSchema(makeOrm('', execute, { platform: 'MySqlPlatform' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('warns and continues when a CONVERT fails (non-fatal)', async () => {
    const execute = vi.fn(async (statement: string) => {
      if (/information_schema/i.test(statement)) {
        return [{ collation: 'utf8mb4_0900_ai_ci' }];
      }
      throw new Error('lock wait timeout exceeded');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      ensureMikroOrmDurableSchema(
        makeOrm('', execute, { platform: 'MySqlPlatform', collate: 'utf8mb4_unicode_ci' }),
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });
});
