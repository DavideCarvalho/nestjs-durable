import {
  DURABLE_STEP_NAME,
  InMemoryStateStore,
  type StepRef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * Step results go out in batches while an engine reads them: one job of the results-batch queue
 * carries the results that finished while the previous batch was being published. A worker that
 * finds no engine reading batches keeps publishing one result per job, which every engine reads.
 * Run with `pnpm test:db` (or `DURABLE_TEST_REDIS_URL`).
 */

const CONTAINER_TIMEOUT = 180_000;
const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
const skipped = !externalUrl && !!process.env.SKIP_TESTCONTAINERS;

let redis: StartedRedisContainer | undefined;
let redisError: unknown;
let connection: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    if (externalUrl) {
      const u = new URL(externalUrl);
      connection = { host: u.hostname, port: Number(u.port || 6379) };
      return;
    }
    redis = await new RedisContainer('redis:7-alpine').start();
    connection = { host: redis.getHost(), port: redis.getFirstMappedPort() };
  } catch (err) {
    redisError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await redis?.stop();
});

const STEP = 'lines.process';
const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (opened.length) await opened.pop()?.close();
});

function available(ctx: { skip: () => void }): boolean {
  if (skipped || redisError || !connection) {
    ctx.skip();
    return false;
  }
  return true;
}

/** Counts `Queue.add` calls per queue name. */
function countAdds(): Map<string, number> {
  const adds = new Map<string, number>();
  const add = Queue.prototype.add;
  vi.spyOn(Queue.prototype, 'add').mockImplementation(function (this: Queue, ...args) {
    adds.set(this.name, (adds.get(this.name) ?? 0) + 1);
    return add.apply(this, args);
  });
  return adds;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition was never met');
}

const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as Record<symbol, string>)[DURABLE_STEP_NAME as symbol] = STEP;

function fanEngine(transport: BullMQTransport) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  engine.register('fan', '1', (ctx, input: { n: number }) =>
    ctx.all(
      processLine,
      Array.from({ length: input.n }, (_, i) => ({ i })),
    ),
  );
  return { store, engine };
}

describe('BullMQ step results in batches', () => {
  it('a busy worker publishes its results in batches, and every step settles once', async (ctx) => {
    if (!available(ctx)) return;
    const prefix = `rb-busy-${Date.now()}`;
    const adds = countAdds();
    const transport = new BullMQTransport({ connection, prefix, concurrency: 32 });
    opened.push(transport);
    let ran = 0;
    transport.handle(STEP, async (input: { i: number }) => {
      ran += 1;
      return input.i * 10;
    });
    const { store, engine } = fanEngine(transport);

    await engine.start('fan', { n: 2_000 }, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(
      Array.from({ length: 2_000 }, (_, i) => i * 10),
    );
    expect(ran).toBe(2_000);
    expect(adds.get(`${prefix}-results`) ?? 0).toBe(0);
    const batches = adds.get(`${prefix}-results-batch`) ?? 0;
    expect(batches).toBeGreaterThan(0);
    expect(batches).toBeLessThan(2_000 / 2);
  }, 60_000);

  it('a worker in another process sends batches once an engine reads them', async (ctx) => {
    if (!available(ctx)) return;
    const prefix = `rb-split-${Date.now()}`;
    const adds = countAdds();
    const engineSide = new BullMQTransport({ connection, prefix });
    const workerSide = new BullMQTransport({ connection, prefix, concurrency: 32 });
    opened.push(workerSide, engineSide);
    workerSide.handle(STEP, async (input: { i: number }) => input.i);
    const { store, engine } = fanEngine(engineSide);
    // The engine's batch consumer is registered before any step runs.
    const batchQueue = new Queue(`${prefix}-results-batch`, { connection });
    opened.push(batchQueue);
    await until(async () => (await batchQueue.getWorkersCount()) > 0);

    await engine.start('fan', { n: 1_000 }, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect(adds.get(`${prefix}-results`) ?? 0).toBe(0);
    expect(adds.get(`${prefix}-results-batch`) ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it('a worker with no engine reading batches publishes one result per job', async (ctx) => {
    if (!available(ctx)) return;
    const prefix = `rb-legacy-${Date.now()}`;
    const workerSide = new BullMQTransport({ connection, prefix, concurrency: 8 });
    opened.push(workerSide);
    workerSide.handle(STEP, async (input: { i: number }) => input.i);
    // An engine that reads one result per job, from the results queue only.
    const seen: number[] = [];
    const legacy = new Worker(
      `${prefix}-results`,
      async (job) => {
        seen.push((job.data as { seq: number }).seq);
      },
      { connection: { ...connection, maxRetriesPerRequest: null } },
    );
    opened.push(legacy);
    await workerSide.dispatchMany(
      Array.from({ length: 50 }, (_, seq) => ({
        runId: 'r',
        seq,
        name: STEP,
        stepId: `r:${seq}`,
        group: STEP,
        input: { i: seq },
        attempt: 1,
      })),
    );
    await until(() => seen.length === 50);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  }, 60_000);
  it('a batch that fails to publish goes out one result per job, and no step runs twice', async (ctx) => {
    if (!available(ctx)) return;
    const prefix = `rb-fail-${Date.now()}`;
    const add = Queue.prototype.add;
    let refused = 0;
    vi.spyOn(Queue.prototype, 'add').mockImplementation(function (this: Queue, ...args) {
      if (this.name === `${prefix}-results-batch` && refused < 3) {
        refused += 1;
        return Promise.reject(new Error('broker blip'));
      }
      return add.apply(this, args);
    });
    const transport = new BullMQTransport({ connection, prefix, concurrency: 8 });
    opened.push(transport);
    const runs = new Map<number, number>();
    transport.handle(STEP, async (input: { i: number }) => {
      runs.set(input.i, (runs.get(input.i) ?? 0) + 1);
      return input.i * 10;
    });
    const { store, engine } = fanEngine(transport);

    await engine.start('fan', { n: 200 }, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect(refused).toBe(3);
    expect((await store.getRun('p'))?.output).toEqual(
      Array.from({ length: 200 }, (_, i) => i * 10),
    );
    expect(runs.size).toBe(200);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  }, 60_000);

  it('an engine reading batches still settles results published one per job', async (ctx) => {
    if (!available(ctx)) return;
    const prefix = `rb-single-${Date.now()}`;
    const engineSide = new BullMQTransport({ connection, prefix });
    opened.push(engineSide);
    const { store, engine } = fanEngine(engineSide);
    // A worker that publishes one result per job, as an older SDK does: it answers each task
    // straight onto the results queue.
    const results = new Queue(`${prefix}-results`, { connection });
    opened.push(results);
    const legacy = new Worker(
      `${prefix}-tasks-${STEP}`,
      async (job) => {
        const t = job.data as { runId: string; seq: number; stepId: string; input: { i: number } };
        await results.add('result', {
          runId: t.runId,
          seq: t.seq,
          stepId: t.stepId,
          status: 'completed',
          output: t.input.i + 1,
        });
      },
      { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 16 },
    );
    opened.push(legacy);

    await engine.start('fan', { n: 300 }, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  }, 60_000);
});
