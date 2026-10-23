import { describe, expect, it } from 'vitest';
import { DbTransport } from './db-transport';
import type { SqlExecutor } from './executors';

/**
 * Queueing runs, taking them and deleting a handled one touch the same run rows from different
 * instances; a database that breaks the resulting deadlock rolls one statement back. The transport
 * runs it again instead of failing the dispatch (which would leave starts to the next poll and
 * resume wakes inline).
 */

function executor(dialect: 'mysql' | 'postgres', deadlocks: { left: number; code: unknown }) {
  const statements: string[] = [];
  const exec: SqlExecutor = {
    dialect,
    escapeId: (id) => (dialect === 'mysql' ? `\`${id}\`` : `"${id}"`),
    query: async <T>(sql: string): Promise<T[]> => {
      statements.push(sql);
      if (/^INSERT/.test(sql.trim()) && sql.includes('_transport_runs') && deadlocks.left > 0) {
        deadlocks.left -= 1;
        throw Object.assign(new Error('Deadlock found when trying to get lock'), {
          code: deadlocks.code,
        });
      }
      return [];
    },
    transaction: async (fn) => fn({ query: async () => [] }),
  };
  return { exec, statements };
}

describe('DbTransport run queue on a deadlock', () => {
  for (const [dialect, code] of [
    ['mysql', 'ER_LOCK_DEADLOCK'],
    ['postgres', '40P01'],
  ] as const) {
    it(`queues the runs once the ${dialect} deadlock is broken`, async () => {
      const deadlocks = { left: 2, code };
      const { exec, statements } = executor(dialect, deadlocks);
      const transport = new DbTransport({ executor: exec, autoCreate: false });
      await expect(
        transport.dispatchRuns([
          { runId: 'b', reason: 'wake' },
          { runId: 'a', reason: 'start', key: '1' },
        ]),
      ).resolves.toBeUndefined();
      expect(deadlocks.left).toBe(0);
      expect(statements.filter((sql) => /^INSERT/.test(sql.trim()))).toHaveLength(3);
      await transport.close();
    });
  }

  it('does not retry another error', async () => {
    const { exec, statements } = executor('mysql', { left: 1, code: 'ER_DUP_ENTRY' });
    const transport = new DbTransport({ executor: exec, autoCreate: false });
    await expect(transport.dispatchRuns([{ runId: 'a' }])).rejects.toThrow();
    expect(statements.filter((sql) => /^INSERT/.test(sql.trim()))).toHaveLength(1);
    await transport.close();
  });
});
