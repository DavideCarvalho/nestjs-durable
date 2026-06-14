import {
  InMemoryStateStore,
  type RemoteStepDef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import IORedis from 'ioredis';
import { z } from 'zod';
import { BullMQTransport } from './bullmq-transport';

const connection = { host: '127.0.0.1', port: 6379 };

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

let redisUp = false;
beforeAll(async () => {
  const probe = new IORedis({ ...connection, maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await probe.connect();
    await probe.ping();
    redisUp = true;
  } catch {
    redisUp = false;
  }
  await probe.quit().catch(() => {});
});

describe('BullMQTransport (real Redis)', () => {
  it('dispatches a remote step over Redis and returns the checkpointed result', async (ctx) => {
    if (!redisUp) ctx.skip();
    const prefix = `durtest-${Date.now()}`;
    const transport = new BullMQTransport({ connection, group: 'payments', prefix });
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.call(chargeCard, { amount: 7 });
      return charge.chargeId;
    });

    const result = await engine.start('checkout', {}, 'run1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_7');

    await transport.close();
  }, 20_000);

  it('reports a failed result when the worker handler throws', async (ctx) => {
    if (!redisUp) ctx.skip();
    const prefix = `durtest-${Date.now()}-f`;
    const transport = new BullMQTransport({ connection, group: 'payments', prefix });
    transport.handle('payments.charge-card', async () => {
      throw new Error('declined');
    });

    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('checkout', '1', async (c) => c.call(chargeCard, { amount: 1 }));

    const result = await engine.start('checkout', {}, 'run1');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('declined');

    await transport.close();
  }, 20_000);

  it('broadcasts control-plane messages over Redis pub/sub', async (ctx) => {
    if (!redisUp) ctx.skip();
    const prefix = `durtest-${Date.now()}-c`;
    const pub = new BullMQTransport({ connection, prefix });
    const sub = new BullMQTransport({ connection, prefix });

    const got: string[] = [];
    sub.onControl((msg) => {
      if (msg.kind === 'cancel') got.push(msg.runId);
    });
    await new Promise((r) => setTimeout(r, 200)); // let the subscription establish
    await pub.publishControl({ kind: 'cancel', runId: 'run-x', from: 'pub' });
    await new Promise((r) => setTimeout(r, 200));

    expect(got).toEqual(['run-x']);
    await pub.close();
    await sub.close();
  }, 20_000);

  it('delivers worker heartbeats over Redis pub/sub', async (ctx) => {
    if (!redisUp) ctx.skip();
    const prefix = `durtest-${Date.now()}-h`;
    const worker = new BullMQTransport({ connection, prefix });
    const engineSide = new BullMQTransport({ connection, prefix });

    const beats: string[] = [];
    engineSide.onHeartbeat(async (b) => {
      beats.push(b.stepId);
    });
    await new Promise((r) => setTimeout(r, 200)); // let the subscription establish
    await worker.heartbeat({ runId: 'r1', seq: 0, stepId: 'r1:0', group: 'payments' });
    await new Promise((r) => setTimeout(r, 200));

    expect(beats).toEqual(['r1:0']);
    await worker.close();
    await engineSide.close();
  }, 20_000);
});
