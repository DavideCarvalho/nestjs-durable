import type { StepResult, WorkflowDecision } from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * Consumer wiring against a real Redis: decision fan-out, the `onResult` single-consumer guard, a
 * `redis://` connection string, and deferred consumers. Uses `DURABLE_TEST_REDIS_URL`
 * (`redis://host:port`) when set, else a testcontainer. Run with `pnpm test:db`.
 */

const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;
let container: StartedRedisContainer | undefined;
let base: { host: string; port: number } | undefined;
let bootError: unknown;

beforeAll(async () => {
  if (skipped) return;
  try {
    if (externalUrl) {
      const u = new URL(externalUrl);
      base = { host: u.hostname, port: Number(u.port || 6379) };
      return;
    }
    container = await new RedisContainer('redis:7-alpine').start();
    base = { host: container.getHost(), port: container.getFirstMappedPort() };
  } catch (err) {
    bootError = err;
  }
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

function live(ctx: { skip: () => void }): { host: string; port: number } {
  if (skipped || bootError || !base) {
    ctx.skip();
    throw new Error('unreachable');
  }
  return base;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('condition was never met');
}

const decision = (taskId: string): WorkflowDecision =>
  ({ taskId, runId: `run-${taskId}`, commands: [] }) as unknown as WorkflowDecision;
const result = (stepId: string): StepResult => ({
  runId: `run-${stepId}`,
  seq: 0,
  stepId,
  status: 'completed',
  output: stepId,
});

describe('BullMQTransport consumers [real Redis]', () => {
  it('delivers every decision to every onDecision handler', async (ctx) => {
    const connection = live(ctx);
    const prefix = `fan${Date.now()}`;
    const t = new BullMQTransport({ connection, prefix, pingIntervalMs: false });
    const a: string[] = [];
    const b: string[] = [];
    t.onDecision(async (d) => {
      a.push(d.taskId);
    });
    t.onDecision(async (d) => {
      b.push(d.taskId);
    });
    const q = new Queue(`${prefix}-decisions`, { connection });
    await q.add('decision', decision('t1'));
    try {
      await until(() => a.length > 0 && b.length > 0);
      expect(a).toEqual(['t1']);
      expect(b).toEqual(['t1']);
    } finally {
      await q.close();
      await t.close();
    }
  });

  it('a second onResult does not start (and leak) a second results worker', async (ctx) => {
    const connection = live(ctx);
    const prefix = `res${Date.now()}`;
    const t = new BullMQTransport({ connection, prefix, pingIntervalMs: false });
    const seen: string[] = [];
    t.onResult(async (r) => {
      seen.push(`first:${r.stepId}`);
    });
    t.onResult(async (r) => {
      seen.push(`second:${r.stepId}`);
    });
    const q = new Queue(`${prefix}-results`, { connection });
    try {
      await q.add('result', result('s1'));
      await until(() => seen.length > 0);
      await t.close();
      // After close() nothing may consume: a leaked worker would still take this one.
      await q.add('result', result('s2'));
      await sleep(800);
      expect(seen).toEqual(['first:s1']);
      expect(await q.getWaitingCount()).toBe(1);
    } finally {
      await q.close();
      await t.close();
    }
  });

  it('accepts a redis:// connection string (host, port and db are honoured)', async (ctx) => {
    const { host, port } = live(ctx);
    const prefix = `url${Date.now()}`;
    const t = new BullMQTransport({
      connection: `redis://${host}:${port}/3` as never,
      prefix,
      pingIntervalMs: false,
    });
    const admin = new Redis({ host, port, db: 3 });
    try {
      await t.dispatch({
        runId: 'r1',
        seq: 0,
        stepId: 'r1:0',
        name: 'charge',
        group: 'charge',
        input: {},
        attempt: 1,
      });
      const keys = await admin.keys(`bull:${prefix}-tasks-charge:*`);
      expect(keys.length).toBeGreaterThan(0);
    } finally {
      admin.disconnect();
      await t.close();
    }
  });

  it('deferConsumers() parks every consumer until startConsumers()', async (ctx) => {
    const connection = live(ctx);
    const prefix = `defer${Date.now()}`;
    const t = new BullMQTransport({ connection, prefix, pingIntervalMs: false });
    t.deferConsumers();
    const ran: string[] = [];
    const results: string[] = [];
    t.handle('charge', async () => {
      ran.push('charge');
      return 'ok';
    });
    t.onResult(async (r) => {
      results.push(r.stepId);
    });
    const admin = new Redis(connection);
    try {
      await t.dispatch({
        runId: 'r1',
        seq: 0,
        stepId: 'r1:0',
        name: 'charge',
        group: 'charge',
        input: {},
        attempt: 1,
      });
      await sleep(800);
      expect(ran).toEqual([]);
      // Not advertised as a live worker while deferred.
      expect(await admin.keys(`${prefix}-worker-heartbeat:*`)).toEqual([]);
      t.startConsumers();
      await until(() => results.length > 0);
      expect(ran).toEqual(['charge']);
      expect(results).toEqual(['r1:0']);
      expect((await admin.keys(`${prefix}-worker-heartbeat:*`)).length).toBeGreaterThan(0);
    } finally {
      admin.disconnect();
      await t.close();
    }
  });

  it('close() on a never-started deferred transport touches no consumer', async (ctx) => {
    const connection = live(ctx);
    const prefix = `deferclose${Date.now()}`;
    const t = new BullMQTransport({
      connection,
      prefix,
      pingIntervalMs: false,
      deferConsumers: true,
    });
    const results: string[] = [];
    t.onResult(async (r) => {
      results.push(r.stepId);
    });
    const q = new Queue(`${prefix}-results`, { connection });
    try {
      await q.add('result', result('s1'));
      await sleep(500);
      await t.close();
      expect(results).toEqual([]);
      expect(await q.getWaitingCount()).toBe(1);
    } finally {
      await q.close();
    }
  });
});
