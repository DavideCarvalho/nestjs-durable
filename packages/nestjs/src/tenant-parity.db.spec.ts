import { type RunRedisWorkerOptions, runRedisWorker } from '@dudousxd/durable-worker';
import {
  DurableWorkflow,
  InMemoryStateStore,
  NO_LIVE_WORKER,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';

/**
 * A real `DurableModule` TENANT (a `connection`, no `store`) against a control plane on a real
 * Redis: the tenant's workflows are orchestrated by the control plane, and the basics work as on a
 * standalone app.
 *  - `MyWorkflow.start()` on the tenant (class statics bound to the tenant's start facade);
 *  - a start issued while no tenant worker is live runs once the worker boots;
 *  - start options (priority, startAt, version, concurrency) are honored by the control plane;
 *  - a run whose tenant worker dies mid-turn is re-driven to another worker and finishes.
 *
 * Skipped without Docker (or with `SKIP_TESTCONTAINERS`) unless `DURABLE_TEST_REDIS_URL` is set.
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
  await redis?.stop();
});

function live(ctx: { skip: () => void }): { host: string; port: number } {
  if (skipped || redisError || !connection) {
    ctx.skip();
    throw new Error('unreachable');
  }
  return connection;
}

/** While set, the first turn of a run listed here never returns: its worker is about to "die". */
const hangOn = new Set<string>();

@Workflow({ name: 'invoice', version: '1' })
class InvoiceWorkflow extends DurableWorkflow {
  async run(ctx: WorkflowCtx, input: { n: number }): Promise<{ total: number }> {
    if (hangOn.has(ctx.runId)) await new Promise<never>(() => undefined);
    return { total: input.n * 2 };
  }
}

/**
 * `runRedisWorker` on real bullmq/ioredis, but with a `crash()` that kills the worker the way a
 * SIGKILL would: its consumers stop without finishing (or failing) the job in hand, and its Redis
 * connections drop, so no heartbeat, result or decision leaves it again.
 */
function crashableRunner() {
  const workers: Worker[] = [];
  const clients: Redis[] = [];
  const queues: Queue[] = [];
  class TrackedWorker extends Worker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      workers.push(this);
    }
  }
  class TrackedQueue extends Queue {
    constructor(...args: ConstructorParameters<typeof Queue>) {
      super(...args);
      queues.push(this);
    }
  }
  class TrackedRedis extends Redis {
    constructor(...args: ConstructorParameters<typeof Redis>) {
      super(...(args as [never]));
      clients.push(this);
    }
    override duplicate(): Redis {
      const copy = super.duplicate();
      clients.push(copy);
      return copy;
    }
  }
  const run = (opts: RunRedisWorkerOptions) =>
    runRedisWorker({
      ...opts,
      deps: {
        Worker: TrackedWorker as never,
        Queue: TrackedQueue as never,
        Redis: TrackedRedis as never,
      },
    });
  const crash = async () => {
    for (const client of clients) client.disconnect();
    await Promise.all(workers.map((w) => w.close(true).catch(() => undefined)));
    await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
  };
  return { run, crash };
}

/** The control plane: the store, a BullMQ transport on the shared prefix, and its timer poll. */
function controlPlane(conn: { host: string; port: number }, prefix: string) {
  const store = new InMemoryStateStore();
  const transport = new BullMQTransport({ connection: conn, prefix });
  const engine = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    namespace: undefined,
    blockedPollMs: 300,
    reconcileMs: 3_000,
  });
  let polling = false;
  const poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void engine
      .resumeDueTimers()
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, 200);
  return {
    store,
    transport,
    close: async () => {
      clearInterval(poll);
      await engine.drain(2_000).catch(() => undefined);
      await transport.close();
    },
  };
}

/** A tenant app: `DurableModule` with a connection and no store, serving partition `acme`. */
async function tenantApp(
  conn: { host: string; port: number },
  prefix: string,
  opts: { consumers?: boolean; runner?: (o: RunRedisWorkerOptions) => Promise<unknown> } = {},
): Promise<INestApplicationContext> {
  let builder = Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        connection: conn,
        prefix,
        partition: 'acme',
        ...(opts.consumers === false ? { consumers: false } : {}),
      }),
    ],
    providers: [InvoiceWorkflow],
  });
  if (opts.runner) builder = builder.overrideProvider(RUN_REDIS_WORKER).useValue(opts.runner);
  const moduleRef = await builder.compile();
  await moduleRef.init();
  return moduleRef;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`condition never met; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const runOf = (
  store: InMemoryStateStore,
  id: string,
  ok: (run: WorkflowRun) => boolean,
  ms?: number,
) =>
  until(
    () => store.getRun(id),
    (run) => run !== null && ok(run),
    ms,
  );

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length > 0)
    await closers
      .pop()?.()
      .catch(() => undefined);
  hangOn.clear();
});

describe('a DurableModule tenant against a control plane (real Redis) [testcontainers]', () => {
  it('MyWorkflow.start() from a tenant with no live worker runs once the worker boots', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-parity-offline-${Date.now()}`;
    const cp = controlPlane(conn, prefix);
    closers.push(cp.close);

    // A producer-only tenant process (no consumer): nothing serves `invoice@acme` yet.
    const producer = await tenantApp(conn, prefix, { consumers: false });
    closers.push(() => producer.close());
    const started = await InvoiceWorkflow.start({ n: 21 }, { id: 'offline-1' });
    expect(started).toEqual({ runId: 'offline-1', status: 'pending' });

    // The control plane keeps the start, waiting for a worker, instead of dropping it.
    const parked = await runOf(cp.store, 'offline-1', (r) => r.status === 'blocked');
    expect(parked.error?.code).toBe(NO_LIVE_WORKER);
    expect(parked.namespace).toBe('acme');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await cp.store.getRun('offline-1'))?.status).toBe('blocked');

    // The tenant worker boots: the run starts there and finishes.
    const worker = await tenantApp(conn, prefix);
    closers.push(() => worker.close());
    // The control plane reads the worker registry through a snapshot up to 30s old (#474), so a
    // worker that boots after it looked is seen within that window.
    const done = await runOf(cp.store, 'offline-1', (r) => r.status === 'completed', 60_000);
    expect(done.output).toEqual({ total: 42 });
    expect(done.workflowVersion).toBe('1');
  }, 90_000);

  it('honors priority, startAt, version and concurrency on a tenant start', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-parity-options-${Date.now()}`;
    const cp = controlPlane(conn, prefix);
    closers.push(cp.close);
    const worker = await tenantApp(conn, prefix);
    closers.push(() => worker.close());
    // The registry is read through a snapshot up to 30s old (#474): wait until it shows the worker.
    await until(
      () => cp.transport.listWorkerGroups(),
      (groups) => groups.includes('invoice@acme'),
      45_000,
    );

    const startAt = Date.now() + 2_500;
    const quota = { key: 'acme-invoices', limit: 1 };
    const delayed = await InvoiceWorkflow.start(
      { n: 1 },
      { id: 'opt-delayed', priority: 5, version: '1', startAt, concurrency: quota },
    );
    expect(delayed.status).toBe('suspended');

    const waiting = await runOf(cp.store, 'opt-delayed', (r) => r.status === 'suspended');
    expect(waiting.priority).toBe(5);
    expect(waiting.workflowVersion).toBe('1');
    expect(waiting.wakeAt).toBe(startAt);
    expect(waiting.tags).toContain('concurrency:acme-invoices');

    // The quota is full while the delayed run waits: a second start is refused, and says why.
    await InvoiceWorkflow.start({ n: 2 }, { id: 'opt-over', concurrency: quota });
    const refused = await runOf(cp.store, 'opt-over', (r) => r.status === 'failed');
    expect(refused.error?.code).toBe('concurrency_limit');

    // A version no live worker declares is not started on the one that is live.
    await InvoiceWorkflow.start({ n: 3 }, { id: 'opt-v2', version: '2' });
    const pinned = await runOf(cp.store, 'opt-v2', (r) => r.status === 'blocked');
    expect(pinned.workflowVersion).toBe('2');

    // The delayed run fires at its startAt, not before.
    const done = await runOf(cp.store, 'opt-delayed', (r) => r.status === 'completed');
    expect(done.updatedAt.getTime()).toBeGreaterThanOrEqual(startAt);
    expect(done.output).toEqual({ total: 2 });
    expect((await cp.store.getRun('opt-v2'))?.status).toBe('blocked');
  }, 90_000);

  it('a run whose tenant worker dies mid-turn is re-driven to another worker and finishes', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-parity-stall-${Date.now()}`;
    const cp = controlPlane(conn, prefix);
    closers.push(cp.close);

    const doomed = crashableRunner();
    const first = await tenantApp(conn, prefix, { runner: doomed.run });
    hangOn.add('stall-1');
    await InvoiceWorkflow.start({ n: 5 }, { id: 'stall-1' });
    // Its turn is in the first worker's hands: the run is suspended on it, with a re-drive deadline.
    const inFlight = await runOf(
      cp.store,
      'stall-1',
      (r) => r.status === 'suspended' && r.awaitingDecisionTaskId !== undefined,
    );
    expect(inFlight.wakeAt).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The first worker dies holding the turn; a second one boots.
    await doomed.crash();
    hangOn.clear();
    const second = await tenantApp(conn, prefix);
    closers.push(() => second.close());
    closers.push(() => Promise.race([first.close(), new Promise((r) => setTimeout(r, 1_000))]));

    const done = await runOf(cp.store, 'stall-1', (r) => r.status === 'completed', 30_000);
    expect(done.output).toEqual({ total: 10 });
  }, 60_000);
});
