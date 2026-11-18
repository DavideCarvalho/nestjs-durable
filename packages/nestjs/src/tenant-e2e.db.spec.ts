import { type RunRedisWorkerOptions, runRedisWorker } from '@dudousxd/durable-worker';
import {
  DurableWorkflow,
  InMemoryStateStore,
  NO_LIVE_WORKER,
  type ScheduledWorkflow,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { type INestApplicationContext, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeadLetter, Step, Workflow } from './decorators';
import type { DurableStartClient } from './durable-start-client';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';
import { StepInterceptor } from './step-interceptor';

/**
 * End to end: a real `DurableModule` TENANT (a `connection`, no `store`) against a `DurableModule`
 * control plane, on a real Redis (plan item 13). Everything a tenant does goes through the control
 * plane, which knows its workflows by name only:
 *  - starts and class statics (`MyWorkflow.start()`), with the `@Workflow` options declared on the
 *    tenant applied by the control plane: tags, a singleton key, an input schema (item 9);
 *  - `signal`, `signalWithStart` and `publishEvent` from tenant app code (item 11);
 *  - a step interceptor on the tenant, and its `@DeadLetter()` handler run on the tenant when one of
 *    its runs dead-letters on the control plane (item 10);
 *  - a schedule declared on the tenant fired by the control plane (#479);
 *  - a start issued while the tenant is down runs once it restarts, and a run whose worker dies
 *    mid-turn is re-driven to another worker (#478).
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
/** What ran on the tenant, by handler. */
const tenantSaw = { deadLetters: [] as unknown[], intercepted: [] as string[] };

@Workflow({
  name: 'e2e-order',
  version: '1',
  tags: ['orders'],
  singleton: { key: (input) => `customer:${(input as { customer: string }).customer}` },
  validateInput: (input) => {
    if ((input as { customer?: unknown }).customer === 'bad') throw new Error('bad customer');
  },
})
class OrderWorkflow extends DurableWorkflow {
  async run(ctx: WorkflowCtx, input: { customer: string }): Promise<unknown> {
    if (hangOn.has(ctx.runId)) await new Promise<never>(() => undefined);
    const priced = await ctx.step<number>('e2e-price', 10);
    const paid = await ctx.waitForSignal<{ amount: number }>(`order:${ctx.runId}`);
    return { customer: input.customer, priced, paid: paid.amount };
  }

  @DeadLetter()
  async onDead(_ctx: WorkflowCtx, dead: DeadLetter): Promise<string> {
    tenantSaw.deadLetters.push(dead);
    return 'handled';
  }
}

@Workflow({ name: 'e2e-receipt', version: '1', onEvent: ['order.paid'] })
class ReceiptWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { order: string }): Promise<string> {
    return `receipt:${input.order}`;
  }
}

@Workflow({ name: 'e2e-ping', version: '1' })
class PingWorkflow extends DurableWorkflow {
  async run(): Promise<string> {
    return 'pong';
  }
}

@Injectable()
class PriceSteps {
  @Step('e2e-price')
  async price(input: number): Promise<number> {
    return input * 3;
  }
}

@StepInterceptor()
@Injectable()
class Audit {
  async intercept(
    invocation: { stepName: string },
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    tenantSaw.intercepted.push(invocation.stepName);
    return next();
  }
}

/**
 * `runRedisWorker` on real bullmq/ioredis, with a `crash()` that kills it the way a SIGKILL would:
 * its consumers stop without finishing the job in hand and its connections drop.
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

/** The control plane: a `DurableModule` operator with a store and BullMQ. */
async function controlPlane(conn: { host: string; port: number }, prefix: string) {
  const store = new InMemoryStateStore();
  const transport = new BullMQTransport({ connection: conn, prefix });
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store,
        transport,
        namespace: undefined,
        timerPollMs: 100,
        blockedPollMs: 300,
        reconcileMs: 3_000,
        maxRecoveryAttempts: 1,
        announcedSchedules: { syncMs: 200, graceMs: 60_000 },
      }),
    ],
  }).compile();
  await moduleRef.init();
  return {
    store,
    transport,
    engine: moduleRef.get(WorkflowEngine),
    close: () => moduleRef.close(),
  };
}

/** A tenant app serving partition `acme`, with a transport for its run requests. */
async function tenantApp(
  conn: { host: string; port: number },
  prefix: string,
  opts: {
    instanceId?: string;
    consumers?: boolean;
    schedules?: ScheduledWorkflow[];
    runner?: (o: RunRedisWorkerOptions) => Promise<unknown>;
  } = {},
): Promise<{ app: INestApplicationContext; engine: DurableStartClient }> {
  let builder = Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        connection: conn,
        prefix,
        partition: 'acme',
        transport: new BullMQTransport({ connection: conn, prefix }),
        ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
        ...(opts.consumers === false ? { consumers: false } : {}),
        ...(opts.schedules ? { schedules: opts.schedules } : {}),
      }),
    ],
    providers: [OrderWorkflow, ReceiptWorkflow, PingWorkflow, PriceSteps, Audit],
  });
  if (opts.runner) builder = builder.overrideProvider(RUN_REDIS_WORKER).useValue(opts.runner);
  const app = await builder.compile();
  await app.init();
  return { app, engine: app.get(WorkflowEngine) as unknown as DurableStartClient };
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`condition never met; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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

/** A signal from the tenant, retried until the run waits on it (a tenant's signal is never buffered). */
async function signalWhenWaiting(
  tenant: DurableStartClient,
  token: string,
  payload: unknown,
): Promise<void> {
  await until(
    () => tenant.signal(token, payload),
    (result) => result !== null,
  );
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length > 0)
    await closers
      .pop()?.()
      .catch(() => undefined);
  hangOn.clear();
  tenantSaw.deadLetters.length = 0;
  tenantSaw.intercepted.length = 0;
});

describe('a DurableModule tenant end to end against a DurableModule control plane [testcontainers]', () => {
  it('starts, options, signals, events and schedules declared on the tenant work through the control plane', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-e2e-flow-${Date.now()}`;
    // The tenant boots first, so the control plane's first read of the worker registry sees it.
    const tenant = await tenantApp(conn, prefix, {
      schedules: [{ key: 'ping', workflow: PingWorkflow, everyMs: 1_000 }],
    });
    closers.push(() => tenant.app.close());
    const cp = await controlPlane(conn, prefix);
    closers.push(cp.close);
    await until(
      () => cp.transport.listWorkerGroups(),
      (groups) => groups.includes('e2e-order@acme'),
      45_000,
    );

    // An input the tenant's validator rejects is refused before anything is sent.
    await expect(OrderWorkflow.start({ customer: 'bad' }, { id: 'o-bad' })).rejects.toThrow(
      /bad customer/,
    );

    // Class statics; the tenant's tags and singleton key are applied by the control plane.
    await OrderWorkflow.start({ customer: 'c1' }, { id: 'o1' });
    await OrderWorkflow.start({ customer: 'c1' }, { id: 'o2' });
    const first = await runOf(cp.store, 'o1', (r) => r.status === 'suspended' && !!r.tags?.length);
    expect(first.namespace).toBe('acme');
    expect(first.tags).toEqual(expect.arrayContaining(['orders', 'singleton:acme/customer:c1']));

    // o1 waits for its payment; o2 shares the key, so it is held behind o1 and runs no step yet.
    // A tenant's signal no run of its partition waits on is answered null, and not buffered.
    expect(await tenant.engine.signal('order:o2', { amount: 0 })).toBeNull();
    await until(
      () => cp.store.listCheckpoints('o1'),
      (cps) => cps.some((cp) => cp.status === 'completed'),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await cp.store.listCheckpoints('o2')).toEqual([]);
    expect((await cp.store.getRun('o2'))?.status).toBe('suspended');
    await signalWhenWaiting(tenant.engine, 'order:o1', { amount: 7 });
    const o1 = await runOf(cp.store, 'o1', (r) => r.status === 'completed');
    expect(o1.output).toEqual({ customer: 'c1', priced: 30, paid: 7 });
    expect(tenantSaw.intercepted).toContain('e2e-price');

    // Once o1 settles, o2 is admitted: signal it too.
    await signalWhenWaiting(tenant.engine, 'order:o2', { amount: 8 });
    expect((await runOf(cp.store, 'o2', (r) => r.status === 'completed')).output).toMatchObject({
      paid: 8,
    });

    // signalWithStart: the run is started and the payment buffered until it waits.
    await tenant.engine.signalWithStart(OrderWorkflow, { customer: 'c3' }, 'o3', {
      token: 'order:o3',
      payload: { amount: 9 },
    });
    expect((await runOf(cp.store, 'o3', (r) => r.status === 'completed')).output).toMatchObject({
      paid: 9,
    });

    // publishEvent: the tenant's own `onEvent` subscriber starts, as a run of its partition.
    await tenant.engine.publishEvent('order.paid', { order: 'o3' }, { id: 'pay-o3' });
    const receipt = await runOf(
      cp.store,
      'evt:pay-o3:e2e-receipt',
      (r) => r.status === 'completed',
    );
    expect(receipt.output).toBe('receipt:o3');
    expect(receipt.namespace).toBe('acme');

    // The tenant's schedule is fired by the control plane and runs on the tenant.
    const pings = await until(
      () => cp.store.listRuns({ tag: 'schedule:app:acme:ping' }),
      (runs) => runs.some((r) => r.status === 'completed'),
    );
    expect(pings.find((r) => r.status === 'completed')?.output).toBe('pong');
  }, 120_000);

  it("a tenant run that dead-letters on the control plane runs the tenant's @DeadLetter() handler on the tenant", async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-e2e-dlq-${Date.now()}`;
    const tenant = await tenantApp(conn, prefix);
    closers.push(() => tenant.app.close());
    const cp = await controlPlane(conn, prefix);
    closers.push(cp.close);
    await until(
      () => cp.transport.listWorkerGroups(),
      (groups) => groups.includes('e2e-order.dlq@acme'),
      45_000,
    );

    // A poison run of the tenant's workflow, already at the control plane's recovery cap.
    await cp.store.createRun({
      id: 'poison',
      workflow: 'e2e-order',
      workflowVersion: '1',
      status: 'running',
      namespace: 'acme',
      input: { customer: 'p' },
      recoveryAttempts: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await runOf(cp.store, 'poison', (r) => r.status === 'dead');
    const handled = await runOf(cp.store, 'dlq:poison', (r) => r.status === 'completed');
    expect(handled.workflow).toBe('e2e-order.dlq');
    expect(handled.namespace).toBe('acme');
    expect(handled.output).toBe('handled');
    expect(tenantSaw.deadLetters).toEqual([
      expect.objectContaining({ deadRunId: 'poison', workflow: 'e2e-order' }),
    ]);
  }, 90_000);

  it('a start issued while the tenant is down runs after it restarts, and a stalled turn is re-driven', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-e2e-restart-${Date.now()}`;
    const cp = await controlPlane(conn, prefix);
    closers.push(cp.close);

    // Only a producer is up: the start waits on the control plane for a worker.
    const producer = await tenantApp(conn, prefix, { consumers: false });
    closers.push(() => producer.app.close());
    await PingWorkflow.start(undefined, { id: 'while-down' });
    const parked = await runOf(cp.store, 'while-down', (r) => r.status === 'blocked');
    expect(parked.error?.code).toBe(NO_LIVE_WORKER);

    // The tenant (re)starts: the waiting run completes there.
    const doomed = crashableRunner();
    const first = await tenantApp(conn, prefix, { instanceId: 'acme-1', runner: doomed.run });
    closers.push(() => Promise.race([first.app.close(), new Promise((r) => setTimeout(r, 1_000))]));
    const done = await runOf(cp.store, 'while-down', (r) => r.status === 'completed', 60_000);
    expect(done.output).toBe('pong');

    // A turn in that worker's hands when it dies is re-driven to the next worker.
    hangOn.add('stall-1');
    await OrderWorkflow.start({ customer: 's' }, { id: 'stall-1' });
    await runOf(
      cp.store,
      'stall-1',
      (r) => r.status === 'suspended' && r.awaitingDecisionTaskId !== undefined,
    );
    await doomed.crash();
    hangOn.clear();
    const second = await tenantApp(conn, prefix, { instanceId: 'acme-2' });
    closers.push(() => second.app.close());
    await signalWhenWaiting(second.engine, 'order:stall-1', { amount: 1 });
    const stalled = await runOf(cp.store, 'stall-1', (r) => r.status === 'completed', 60_000);
    expect(stalled.output).toMatchObject({ customer: 's', paid: 1 });
  }, 150_000);
});
