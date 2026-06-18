import {
  InMemoryStateStore,
  type RemoteStepDef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BullMQTransport } from './bullmq-transport';

/**
 * Real-broker matrix for the BullMQ transport: a Redis instance spun up via testcontainers, so the
 * remote-step round-trip, the failed-result path, and the control-plane / heartbeat pub/sub are
 * exercised against an actual Redis instead of self-skipping. Run with `pnpm test:db`.
 *
 * Skips cleanly (each case logs once and passes) when Docker is unavailable or `SKIP_TESTCONTAINERS`
 * is set — never fails the suite for a missing daemon. One container shared across the cases.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;

let redis: StartedRedisContainer | undefined;
let redisError: unknown;
let connection: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    redis = await new RedisContainer('redis:7-alpine').start();
    connection = { host: redis.getHost(), port: redis.getFirstMappedPort() };
  } catch (err) {
    redisError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await redis?.stop();
});

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

/** A durable ctx.call suspends; poll the store until the Redis round-trip resumes it to terminal. */
async function settle(store: InMemoryStateStore, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended')
      return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Resolve the live connection or self-skip the case when Docker isn't available. */
function liveConnection(ctx: { skip: () => void }): { host: string; port: number } {
  if (skipped) {
    ctx.skip();
    throw new Error('unreachable'); // ctx.skip() aborts; keeps the type non-undefined
  }
  if (redisError || !connection) {
    ctx.skip();
    throw new Error('unreachable');
  }
  return connection;
}

describe('BullMQTransport (real Redis) [testcontainers]', () => {
  it('dispatches a remote step over Redis and returns the checkpointed result', async (ctx) => {
    const connection = liveConnection(ctx);
    const prefix = `durtest-${Date.now()}`;
    const transport = new BullMQTransport({ connection, group: 'payments', prefix });
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.call(chargeCard, { amount: 7 });
      return charge.chargeId;
    });

    await engine.start('checkout', {}, 'run1');
    const result = await settle(store, 'run1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_7');

    await transport.close();
  }, 30_000);

  it('reports a failed result when the worker handler throws', async (ctx) => {
    const connection = liveConnection(ctx);
    const prefix = `durtest-${Date.now()}-f`;
    const transport = new BullMQTransport({ connection, group: 'payments', prefix });
    transport.handle('payments.charge-card', async () => {
      throw new Error('declined');
    });

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => c.call(chargeCard, { amount: 1 }));

    await engine.start('checkout', {}, 'run1');
    const result = await settle(store, 'run1');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('declined');

    await transport.close();
  }, 30_000);

  it('broadcasts control-plane messages over Redis pub/sub', async (ctx) => {
    const connection = liveConnection(ctx);
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
    const connection = liveConnection(ctx);
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
