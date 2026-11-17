import type { RemoteTask, StepResult } from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport, type BullMQTransportOptions } from './bullmq-transport';

/**
 * `taskQueues: 'grouped'` and `taskQueueDrain` against real BullMQ: one shared queue serves several
 * handlers, each at its own limit (the overflow hand-back uses BullMQ's real `moveToDelayed`), a job
 * for a handler the process lacks is handed back for another process, and the drain path empties the
 * other layout's queues in both directions. Uses `DURABLE_TEST_REDIS_URL` when set, else a
 * testcontainers Redis; skipped when neither is available.
 */
const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
let container: StartedRedisContainer | undefined;
let connection: { host: string; port: number } | undefined;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  try {
    if (externalUrl) {
      const u = new URL(externalUrl);
      connection = { host: u.hostname, port: Number(u.port || 6379) };
      return;
    }
    if (process.env.SKIP_TESTCONTAINERS) return;
    container = await new RedisContainer('redis:7-alpine').start();
    connection = { host: container.getHost(), port: container.getFirstMappedPort() };
  } catch {
    connection = undefined;
  }
}, 120_000);

afterAll(async () => {
  for (const c of closers.reverse()) await c().catch(() => {});
  await container?.stop();
});

const task = (name: string, runId: string, seq: number, group = name): RemoteTask => ({
  runId,
  seq,
  name,
  stepId: `${runId}:${seq}`,
  group,
  input: { seq },
  attempt: 0,
});

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function transport(
  prefix: string,
  instanceId: string,
  extra: Partial<BullMQTransportOptions> = {},
): BullMQTransport {
  const t = new BullMQTransport({
    connection: connection as { host: string; port: number },
    prefix,
    instanceId,
    closeTimeoutMs: 2_000,
    pingIntervalMs: false,
    replyRouting: false,
    ...extra,
  });
  closers.push(() => t.close());
  return t;
}

describe("BullMQTransport taskQueues: 'grouped' (real Redis)", () => {
  it('runs every handler off one queue, each at its own limit', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durgrp-${Date.now()}-a`;
    const engine = transport(prefix, 'engine', { taskQueues: 'grouped' });
    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });

    const worker = transport(prefix, 'w1', { taskQueues: 'grouped' });
    let slowRunning = 0;
    let slowMax = 0;
    let fastDuringSlow = 0;
    worker.handle('slow', async () => {
      slowRunning += 1;
      slowMax = Math.max(slowMax, slowRunning);
      await new Promise((r) => setTimeout(r, 150));
      slowRunning -= 1;
      return 'slow';
    });
    worker.handle('fast', async () => {
      if (slowRunning > 0) fastDuringSlow += 1;
      return 'fast';
    });

    await engine.dispatchMany([
      ...Array.from({ length: 5 }, (_, i) => task('slow', 'run-slow', i + 1)),
      ...Array.from({ length: 5 }, (_, i) => task('fast', 'run-fast', i + 1)),
    ]);
    await until(() => results.length === 10, 30_000);

    expect(results.every((r) => r.status === 'completed')).toBe(true);
    // Default concurrency 1 per handler: `slow` never ran two at once, and `fast` was not stuck
    // behind `slow`'s backlog.
    expect(slowMax).toBe(1);
    expect(fastDuringSlow).toBeGreaterThan(0);
    // No per-handler queue was used.
    const perHandler = new Queue(`${prefix}-tasks-slow`, { connection });
    expect(await perHandler.count()).toBe(0);
    await perHandler.close();
    const health = await engine.groupHealth('slow');
    expect(health).toMatchObject({ group: 'slow', queue: `${prefix}-taskgroup`, queueDepth: 0 });
    expect(health.liveWorkers.map((w) => w.instanceId)).toEqual(['w1']);
  }, 60_000);

  it('a partition gets its own shared queue', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durgrp-${Date.now()}-p`;
    const engine = transport(prefix, 'engine', { taskQueues: 'grouped' });
    await engine.dispatch(task('charge', 'run-p', 1, 'charge@acme'));
    const queue = new Queue(`${prefix}-taskgroup@acme`, { connection });
    expect(await queue.count()).toBe(1);
    const health = await engine.groupHealth('charge@acme');
    expect(health).toMatchObject({ depth: 1, queue: `${prefix}-taskgroup@acme`, queueDepth: 1 });
    await queue.obliterate({ force: true });
    await queue.close();
  }, 30_000);

  it('hands a job for a handler it lacks back to the queue for another process', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durgrp-${Date.now()}-f`;
    const engine = transport(prefix, 'engine', { taskQueues: 'grouped' });
    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });
    const lacking = transport(prefix, 'w-lacking', { taskQueues: 'grouped' });
    lacking.handle('other', async () => 'other');
    await engine.dispatch(task('mine', 'run-f', 1));
    const queue = new Queue(`${prefix}-taskgroup`, { connection });
    await until(async () => (await queue.getDelayedCount()) === 1, 10_000);
    expect(results).toEqual([]);
    // Only the process that serves it is left: offered again, the job runs there.
    await lacking.close();
    await queue.promoteJobs();
    const serving = transport(prefix, 'w-serving', { taskQueues: 'grouped' });
    serving.handle('mine', async () => 'mine');
    await until(() => results.length === 1, 20_000);
    expect(results[0]).toMatchObject({ status: 'completed', output: 'mine' });
    await queue.close();
  }, 60_000);

  it('drains waiting and delayed jobs from per-handler queues, then stops draining', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durgrp-${Date.now()}-d`;
    // An old (per-handler) engine dispatches while no per-handler worker runs any more.
    const oldEngine = transport(prefix, 'old-engine');
    const results: StepResult[] = [];
    oldEngine.onResult(async (r) => {
      results.push(r);
    });
    await oldEngine.dispatch(task('legacy.a', 'run-old', 1));
    await oldEngine.dispatch(task('legacy.b', 'run-old', 2));
    // A delayed job (a retry backoff on the old layout) must be picked up once due.
    const legacyQueue = new Queue(`${prefix}-tasks-legacy.a`, { connection });
    await legacyQueue.add('task', task('legacy.a', 'run-old', 3), {
      delay: 400,
      removeOnComplete: true,
    });
    await legacyQueue.close();

    const worker = transport(prefix, 'new', {
      taskQueues: 'grouped',
      taskQueueDrain: { intervalMs: 200 },
    });
    // While drained, the health of a group reports what still waits on its own queue.
    const health = await worker.groupHealth('legacy.a');
    expect(health.drainingDepth).toBe(2);
    worker.handle('legacy.a', async (input) => `a${(input as { seq: number }).seq}`);
    worker.handle('legacy.b', async () => 'b');
    worker.handle('never.used', async () => 'x');

    await until(() => results.length === 3, 30_000);
    expect(results.map((r) => r.seq).sort()).toEqual([1, 2, 3]);
    // Both legacy queues emptied, so their drain workers stop; the unused one never got one.
    await until(() => worker.drainingQueues.length === 0, 10_000);
    expect((await worker.groupHealth('legacy.a')).drainingDepth).toBeUndefined();
  }, 60_000);

  it('rolls back: a per-handler worker with taskQueueDrain drains the grouped queue', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durgrp-${Date.now()}-r`;
    const groupedEngine = transport(prefix, 'g-engine', { taskQueues: 'grouped' });
    const results: StepResult[] = [];
    groupedEngine.onResult(async (r) => {
      results.push(r);
    });
    await groupedEngine.dispatch(task('rb.step', 'run-rb', 1));

    const worker = transport(prefix, 'ph', { taskQueueDrain: { intervalMs: 200 } });
    worker.handle('rb.step', async () => 'ok');
    await until(() => results.length === 1, 30_000);
    expect(results[0]?.status).toBe('completed');
    await until(() => worker.drainingQueues.length === 0, 10_000);
  }, 60_000);

  it('keeps workflow tasks on the per-handler queue', async (ctx) => {
    if (!connection) return ctx.skip();
    const prefix = `durgrp-${Date.now()}-w`;
    const engine = transport(prefix, 'engine', { taskQueues: 'grouped' });
    await engine.dispatchWorkflowTask({
      taskId: 't1',
      runId: 'r1',
      workflow: 'pipeline',
      workflowVersion: '1',
      input: {},
      history: [],
      group: 'pipeline',
    });
    const queue = new Queue(`${prefix}-tasks-pipeline`, { connection });
    expect(await queue.count()).toBe(1);
    await queue.obliterate({ force: true });
    await queue.close();
  }, 30_000);
});
