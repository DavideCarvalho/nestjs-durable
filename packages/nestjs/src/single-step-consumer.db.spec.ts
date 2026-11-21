import { randomUUID } from 'node:crypto';
import { type RunnerDeps, runRedisWorker } from '@dudousxd/durable-worker';
import { Context, ContextModule } from '@dudousxd/nestjs-context';
import { InMemoryStateStore, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Step, Workflow } from './decorators';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { IN_APP_RUN_REDIS_WORKER, type RunRedisWorkerFn } from './in-app-worker';
import { WorkflowService } from './workflow.service';

/**
 * One consumer per step queue, over a real Redis. A co-located worker (`store` + `connection`)
 * consumes its `@Step` queues through its in-app worker runtime; the transport must not start a
 * second BullMQ Worker on the same queue, or the two race for each job and the transport's copy
 * runs the step without the context carrier and outside the step consumer's settings.
 */

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
}, 180_000);

afterAll(async () => {
  Context.resetConfig();
  await redis?.stop();
});

async function until<T>(read: () => Promise<T> | T, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The trace id each `@Step` run saw, by the run's input. */
const seen = new Map<string, string | undefined>();
/** The trace id each run's turn ran in (on the in-app worker, inside the turn's carrier). */
const turnTrace = new Map<string, string | undefined>();

@Injectable()
class Probe {
  @Step('probe.run')
  async run(input: { key: string }) {
    seen.set(input.key, Context.traceId());
    return input.key;
  }
}

@Workflow({ name: 'probe.flow', version: '1' })
class ProbeFlow {
  constructor(private readonly probe: Probe) {}

  async run(ctx: WorkflowCtx, input: { key: string }) {
    if (!turnTrace.has(input.key)) turnTrace.set(input.key, Context.traceId());
    return ctx.step(this.probe.run, input);
  }
}

/** The real in-app runner, with each BullMQ Worker it starts recorded with its options. */
function recordingRunner() {
  const started: Array<{ queue: string; opts: Record<string, unknown> }> = [];
  class RecordingWorker extends Worker {
    constructor(queue: string, processor: never, opts: never) {
      super(queue, processor, opts);
      started.push({ queue, opts: opts as Record<string, unknown> });
    }
  }
  const deps = {
    Worker: RecordingWorker,
    Queue,
    Redis,
  } as unknown as RunnerDeps;
  const run: RunRedisWorkerFn = (opts) => runRedisWorker({ ...opts, deps });
  return { run, started };
}

async function boot(options: DurableModuleOptions, runner?: RunRedisWorkerFn) {
  let builder = Test.createTestingModule({
    imports: [
      ContextModule.forRoot({ autoMiddleware: false, carrier: ['traceId'] }),
      DurableModule.forRoot(options),
    ],
    providers: [Probe, ProbeFlow],
  });
  if (runner) builder = builder.overrideProvider(IN_APP_RUN_REDIS_WORKER).useValue(runner);
  const moduleRef = await builder.compile();
  await moduleRef.init();
  return moduleRef;
}

/** How many BullMQ Workers are connected to `queue` right now. */
async function consumersOf(queue: string): Promise<number> {
  const q = new Queue(queue, { connection: connection as { host: string; port: number } });
  try {
    return (await q.getWorkers()).length;
  } finally {
    await q.close();
  }
}

describe('one consumer per step queue (real Redis) [testcontainers]', () => {
  it('a co-located worker is the only consumer of its step queue, with its own settings, and every step sees its trace', async (ctx) => {
    if (skipped || redisError || !connection) {
      ctx.skip();
      return;
    }
    const prefix = `single-${randomUUID().slice(0, 8)}`;
    const runner = recordingRunner();
    const store = new InMemoryStateStore();
    const moduleRef = await boot(
      {
        store,
        transport: new BullMQTransport({ connection, prefix, partition: 'p1', concurrency: 4 }),
        connection,
        prefix,
        partition: 'p1',
        concurrency: 1,
        concurrencyByHandler: { 'probe.run': 3 },
        lockDuration: 45_000,
        stalledInterval: 15_000,
        maxStalledCount: 2,
        autoSchema: false,
        // Like an app that always stamps a trace: the request's, or a fresh one where the engine
        // dispatches outside any request (a run taken off the run queue).
        context: () => ({ traceId: Context.traceId() ?? randomUUID().replaceAll('-', '') }),
      },
      runner.run,
    );
    try {
      const stepQueue = `${prefix}-tasks-probe.run@p1`;
      // The in-app worker's Worker on the step queue carries the step consumer's settings ...
      const own = await until(
        () => runner.started.filter((w) => w.queue === stepQueue),
        (ws) => ws.length > 0,
      );
      expect(own).toHaveLength(1);
      expect(own[0]?.opts).toMatchObject({
        concurrency: 3,
        lockDuration: 45_000,
        stalledInterval: 15_000,
        maxStalledCount: 2,
      });
      // ... and it is the only BullMQ Worker on that queue.
      await until(
        () => consumersOf(stepQueue),
        (n) => n >= 1,
      );
      expect(await consumersOf(stepQueue)).toBe(1);

      const service = moduleRef.get(WorkflowService);
      // Every step runs on the in-app worker, inside the carrier its turn's decision was applied
      // under: the trace the turn itself ran in. A second consumer on the queue would run some
      // without any carrier.
      for (let i = 0; i < 20; i += 1) {
        const key = `k${i}`;
        await service.start('probe.flow', { key }, `run-${i}`);
        await until(
          async () => (await store.getRun(`run-${i}`))?.status,
          (status) => status === 'completed',
        );
        expect(turnTrace.get(key), `run ${i} turn`).toMatch(/^[0-9a-f]{32}$/);
        expect(seen.get(key), `run ${i} step`).toBe(turnTrace.get(key));
      }
    } finally {
      await moduleRef.close();
    }
  }, 120_000);

  it('a plain operator (no connection) still serves its steps through the transport', async (ctx) => {
    if (skipped || redisError || !connection) {
      ctx.skip();
      return;
    }
    const prefix = `plain-${randomUUID().slice(0, 8)}`;
    const store = new InMemoryStateStore();
    const moduleRef = await boot({
      store,
      transport: new BullMQTransport({ connection, prefix }),
      autoSchema: false,
    });
    try {
      const stepQueue = `${prefix}-tasks-probe.run`;
      await until(
        () => consumersOf(stepQueue),
        (n) => n >= 1,
      );
      expect(await consumersOf(stepQueue)).toBe(1);
      const service = moduleRef.get(WorkflowService);
      await service.start('probe.flow', { key: 'plain' }, 'plain-1');
      await until(
        async () => (await store.getRun('plain-1'))?.status,
        (status) => status === 'completed',
      );
      expect(seen.has('plain')).toBe(true);
    } finally {
      await moduleRef.close();
    }
  }, 60_000);

  it("a co-located worker on the grouped layout keeps the transport's consumer of its taskgroup queue", async (ctx) => {
    if (skipped || redisError || !connection) {
      ctx.skip();
      return;
    }
    // The in-app runtime subscribes per-handler queues only, so the grouped `<prefix>-taskgroup`
    // queue's one consumer is the transport's; without it the step would never run.
    const prefix = `grouped-${randomUUID().slice(0, 8)}`;
    const store = new InMemoryStateStore();
    const moduleRef = await boot({
      store,
      transport: new BullMQTransport({
        connection,
        prefix,
        partition: 'p1',
        taskQueues: 'grouped',
      }),
      connection,
      prefix,
      partition: 'p1',
      autoSchema: false,
    });
    try {
      const taskGroup = `${prefix}-taskgroup@p1`;
      await until(
        () => consumersOf(taskGroup),
        (n) => n >= 1,
      );
      expect(await consumersOf(taskGroup)).toBe(1);
      const service = moduleRef.get(WorkflowService);
      await service.start('probe.flow', { key: 'grouped' }, 'grouped-1');
      await until(
        async () => (await store.getRun('grouped-1'))?.status,
        (status) => status === 'completed',
      );
      expect(seen.has('grouped')).toBe(true);
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});
