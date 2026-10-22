import { describe, expect, it } from 'vitest';
import { DbTransport } from './db-transport';
import type { SqlExecutor } from './executors';

/** An executor that records every statement and returns no rows. */
function recordingExecutor(): SqlExecutor & { sql: string[] } {
  const sql: string[] = [];
  const query = async <T>(text: string): Promise<T[]> => {
    sql.push(text);
    return [];
  };
  return {
    sql,
    dialect: 'postgres',
    escapeId: (id) => `"${id}"`,
    query,
    transaction: (fn) => fn({ query }),
  };
}

describe('DbTransport options', () => {
  it('two instances booted in the same millisecond get distinct instance ids', () => {
    const now = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const a = new DbTransport({ executor: recordingExecutor() });
      const b = new DbTransport({ executor: recordingExecutor() });
      expect((a as unknown as { instanceId: string }).instanceId).not.toBe(
        (b as unknown as { instanceId: string }).instanceId,
      );
    } finally {
      Date.now = now;
    }
  });

  it('a non-finite numeric option falls back to its default instead of reaching the SQL', async () => {
    const executor = recordingExecutor();
    const transport = new DbTransport({
      executor,
      group: 'g',
      autoCreate: false,
      batchSize: Number.NaN,
      concurrency: Number.NaN,
      pollMs: Number.NaN,
      leaseMs: Number.POSITIVE_INFINITY,
    });
    const opts = transport as unknown as {
      batchSize: number;
      concurrency: number;
      pollMs: number;
      leaseMs: number;
    };
    expect([opts.batchSize, opts.concurrency, opts.pollMs, opts.leaseMs]).toEqual([
      10, 1, 500, 30_000,
    ]);
    transport.handle('step', async () => 'ok');
    const deadline = Date.now() + 2_000;
    while (!executor.sql.some((s) => s.includes('LIMIT')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await transport.close();
    const claim = executor.sql.find((s) => s.includes('LIMIT')) ?? '';
    expect(claim).toMatch(/LIMIT 1 FOR UPDATE SKIP LOCKED/);
    expect(executor.sql.join('\n')).not.toMatch(/NaN|Infinity/);
  });
});
