import 'reflect-metadata';
import {
  InMemoryStateStore,
  type RemoteStepDef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { DbTransport } from './db-transport';
import { typeOrmExecutor } from './executors';

// SKIP LOCKED needs MySQL 8+. flip runs one on :3306; skip when it isn't up.
const dbConfig = {
  type: 'mysql' as const,
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  username: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? 'password',
  database: process.env.MYSQL_DB ?? 'flip',
};

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

let ds: DataSource;
let dbUp = false;
beforeAll(async () => {
  ds = new DataSource(dbConfig);
  try {
    await ds.initialize();
    dbUp = true;
  } catch {
    dbUp = false;
  }
});
afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

async function dropTables(prefix: string) {
  await ds.query(`DROP TABLE IF EXISTS \`${prefix}_transport_tasks\``);
  await ds.query(`DROP TABLE IF EXISTS \`${prefix}_transport_results\``);
}

describe('DbTransport (real MySQL)', () => {
  it('dispatches a remote step through the DB and returns the checkpointed result', async (ctx) => {
    if (!dbUp) ctx.skip();
    const prefix = `durtest${Date.now()}`;
    const transport = new DbTransport({ executor: typeOrmExecutor(ds), group: 'payments', prefix, pollMs: 50 });
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.call(chargeCard, { amount: 7 });
      return charge.chargeId;
    });

    const result = await engine.start('checkout', {}, `run-${prefix}`);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_7');

    await transport.close();
    await dropTables(prefix);
  }, 30_000);

  it('reports a failed result when the worker handler throws', async (ctx) => {
    if (!dbUp) ctx.skip();
    const prefix = `durtestf${Date.now()}`;
    const transport = new DbTransport({ executor: typeOrmExecutor(ds), group: 'payments', prefix, pollMs: 50 });
    transport.handle('payments.charge-card', async () => {
      throw new Error('declined');
    });

    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('checkout', '1', async (c) => c.call(chargeCard, { amount: 1 }));

    const result = await engine.start('checkout', {}, `run-${prefix}`);
    expect(result.status).toBe('failed');

    await transport.close();
    await dropTables(prefix);
  }, 30_000);
});
