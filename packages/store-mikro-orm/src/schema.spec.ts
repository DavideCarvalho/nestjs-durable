import type { MikroORM } from '@mikro-orm/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureMikroOrmDurableSchema } from './schema';

/** Minimal ORM double: a fixed update-schema SQL string + a connection whose `execute` we control. */
function makeOrm(sql: string, execute: (statement: string) => Promise<void>): MikroORM {
  return {
    schema: { getUpdateSchemaSQL: async () => sql },
    em: { getConnection: () => ({ execute }) },
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
});
