import {
  type EngineEvent,
  InMemoryStateStore,
  type RunReply,
  type RunRequest,
  type TenantEvent,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport, toBrokerPriority } from './bullmq-transport';

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

const CHARGE_CARD_STEP_NAME = 'payments.charge-card';

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

/** Poll `predicate` until it's true, mirroring `settle()`'s loop shape for non-store round-trips
 *  (e.g. a queue-delivered message landing in a locally-collected array). */
async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition was never met');
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
    const transport = new BullMQTransport({ connection, prefix });
    transport.handle(CHARGE_CARD_STEP_NAME, async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => {
      const charge = await c.step<{ chargeId: string }>(CHARGE_CARD_STEP_NAME, { amount: 7 });
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
    const transport = new BullMQTransport({ connection, prefix });
    transport.handle(CHARGE_CARD_STEP_NAME, async () => {
      throw new Error('declined');
    });

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (c) => c.step(CHARGE_CARD_STEP_NAME, { amount: 1 }));

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

  it('forwards a task priority onto the enqueued BullMQ job', async (ctx) => {
    const connection = liveConnection(ctx);
    const prefix = `durtest-${Date.now()}-p`;
    const transport = new BullMQTransport({ connection, prefix });
    await transport.dispatch({
      runId: 'r1',
      seq: 0,
      name: CHARGE_CARD_STEP_NAME,
      stepId: 'r1:0',
      group: 'payments',
      input: { amount: 1 },
      attempt: 1,
      priority: 9,
    });

    // Read the job back from the group's task queue and check its translated priority.
    const queue = new Queue(`${prefix}-tasks-payments`, { connection });
    const jobs = await queue.getJobs(['prioritized', 'wait']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.opts.priority).toBe(toBrokerPriority(9));

    await queue.close();
    await transport.close();
  }, 20_000);

  it('round-trips a RunRequest over the request queue', async (ctx) => {
    const connection = liveConnection(ctx);
    const prefix = `durtest-${Date.now()}-rr`;
    const dispatcher = new BullMQTransport({ connection, prefix });
    const controlPlane = new BullMQTransport({ connection, prefix });

    const seen: RunRequest[] = [];
    controlPlane.onRunRequest(async (msg) => {
      seen.push(msg);
    });

    await dispatcher.dispatchRunRequest({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'cancel', runId: 'r1' },
    });

    await waitUntil(() => seen.length === 1);
    expect(seen[0]).toMatchObject({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'cancel', runId: 'r1' },
    });

    await dispatcher.close();
    await controlPlane.close();
  }, 20_000);

  it('fans a RunReply to onRunReply subscribers over Redis pub/sub', async (ctx) => {
    const connection = liveConnection(ctx);
    const prefix = `durtest-${Date.now()}-rp`;
    const controlPlane = new BullMQTransport({ connection, prefix });
    const tenantWorker = new BullMQTransport({ connection, prefix });

    const seen: RunReply[] = [];
    tenantWorker.onRunReply((reply) => seen.push(reply));
    await new Promise((r) => setTimeout(r, 200)); // let the subscription establish

    await controlPlane.publishRunReply({ requestId: 'q1', result: { ok: true, data: null } });
    await new Promise((r) => setTimeout(r, 200));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBe('q1');

    await controlPlane.close();
    await tenantWorker.close();
  }, 20_000);

  it("delivers a TenantEvent only to that tenant's channel", async (ctx) => {
    const connection = liveConnection(ctx);
    const prefix = `durtest-${Date.now()}-te`;
    const controlPlane = new BullMQTransport({ connection, prefix });
    const tenantWorker = new BullMQTransport({ connection, prefix });

    const makeEvent = (runId: string): EngineEvent => ({ type: 'run.completed', runId });

    const acme: TenantEvent[] = [];
    const off = tenantWorker.onTenantEvent('acme', (evt) => acme.push(evt));
    await new Promise((r) => setTimeout(r, 200)); // let the subscription establish

    await controlPlane.publishTenantEvent({ tenant: 'beta', event: makeEvent('run-x') });
    await controlPlane.publishTenantEvent({ tenant: 'acme', event: makeEvent('run-1') });
    await new Promise((r) => setTimeout(r, 200));

    expect(acme).toHaveLength(1); // NOT the beta event
    expect(acme[0]?.event.runId).toBe('run-1');

    off();
    await controlPlane.close();
    await tenantWorker.close();
  }, 20_000);
});
