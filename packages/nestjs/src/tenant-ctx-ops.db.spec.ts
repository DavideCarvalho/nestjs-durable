import {
  DurableWorkflow,
  InMemoryStateStore,
  SignalTimeoutError,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowRun,
  eventPrefix,
} from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { type INestApplicationContext, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Step, Workflow } from './decorators';
import { DurableModule } from './durable.module';

/**
 * A real `DurableModule` TENANT (a `connection`, no `store`) against a control plane on a real
 * Redis, running workflow code that uses the `ctx` operations a tenant could not run before:
 *  - a `@Step` with `retries` + `backoffMs`, and one with `retries` + `timeoutMs`, enforced by the
 *    control plane as a standalone engine enforces them;
 *  - `sleepUntil`, a bounded `waitForSignal` that times out, `waitForEvent`, fire-and-forget
 *    `startChild`, `setEvent` and `continueAsNew`.
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

/** Attempts per step per run key, as the tenant's step handlers saw them. */
const attempts = new Map<string, number>();
const attempt = (key: string): number => {
  const n = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, n);
  return n;
};

@Injectable()
class OpsSteps {
  /** Fails its first two attempts: `retries: 3` with a backoff must bring it home on the third. */
  @Step({ name: 'ops.flaky', retries: 3, backoffMs: 300 })
  async flaky(input: { key: string }): Promise<number> {
    const n = attempt(`flaky:${input.key}`);
    if (n < 3) throw new Error(`flaky attempt ${n}`);
    return n;
  }

  /**
   * Its first attempt outlives `timeoutMs`: the control plane must re-dispatch it. The consumer may
   * run the two attempts one after the other, and then the late first result settles the step as it
   * would in-process (results are keyed by the step, not the attempt) — either way it is dispatched
   * twice and completes instead of failing with a timeout.
   */
  @Step({ name: 'ops.slow', retries: 2, timeoutMs: 2_500 })
  async slow(input: { key: string }): Promise<string> {
    const n = attempt(`slow:${input.key}`);
    if (n === 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return 'late';
    }
    return 'fast';
  }
}

@Workflow({ name: 'ops-kid', version: '1' })
class KidWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { n: number }): Promise<number> {
    return input.n * 10;
  }
}

@Workflow({ name: 'ops', version: '1' })
class OpsWorkflow extends DurableWorkflow {
  constructor(private readonly steps: OpsSteps) {
    super();
  }

  async run(ctx: WorkflowCtx, input: { key: string; until: number }) {
    const flaky = await ctx.step(this.steps.flaky, { key: input.key });
    const slow = await ctx.step(this.steps.slow, { key: input.key });
    await ctx.setEvent('stage', 'stepped');
    await ctx.sleepUntil(input.until);
    const childId = await ctx.startChild(KidWorkflow, { n: 4 }, `${ctx.runId}-kid`);
    let approval: string;
    try {
      approval = await ctx.waitForSignal<string>(`approve-${input.key}`, { timeoutMs: 1_000 });
    } catch (err) {
      if (!(err instanceof SignalTimeoutError)) throw err;
      approval = 'timed-out';
    }
    await ctx.setEvent('stage', 'awaiting-payment');
    const paid = await ctx.waitForEvent<{ key: string; total: number }>('order.paid', {
      match: { key: input.key },
      timeoutMs: 60_000,
    });
    return { flaky, slow, approval, paid, childId };
  }
}

@Workflow({ name: 'ops-counter', version: '1' })
class CounterWorkflow extends DurableWorkflow {
  async run(ctx: WorkflowCtx, input: { n: number }): Promise<number> {
    if (input.n < 2) await ctx.continueAsNew({ n: input.n + 1 });
    return input.n;
  }
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
  }, 100);
  return {
    store,
    engine,
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
): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ connection: conn, prefix, partition: 'acme' })],
    providers: [OpsSteps, OpsWorkflow, KidWorkflow, CounterWorkflow],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
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
  attempts.clear();
});

describe('ctx operations and step policy on a DurableModule tenant (real Redis) [testcontainers]', () => {
  it('runs step retries/timeout, sleepUntil, timed waitForSignal, waitForEvent, startChild and setEvent', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-tenant-ops-${Date.now()}`;
    const cp = controlPlane(conn, prefix);
    closers.push(cp.close);
    const tenant = await tenantApp(conn, prefix);
    closers.push(() => tenant.close());
    // The registry is read through a snapshot up to 30s old (#474): wait until it shows the worker.
    await until(
      () => cp.transport.listWorkerGroups(),
      (groups) => groups.includes('ops@acme'),
      45_000,
    );

    const wakeAt = Date.now() + 8_000;
    await OpsWorkflow.start({ key: 'k1', until: wakeAt }, { id: 'ops-1' });

    // Both steps settled under their policies before the run moved on.
    await until(
      () => cp.engine.getEvent('ops-1', 'stage'),
      (stage) => stage === 'stepped',
    );
    const checkpoints = await cp.store.listCheckpoints('ops-1');
    const flaky = checkpoints.find((c) => c.name === 'ops.flaky');
    const slow = checkpoints.find((c) => c.name === 'ops.slow');
    expect(flaky).toMatchObject({ status: 'completed', output: 3, attempts: 3 });
    expect(slow).toMatchObject({ status: 'completed', attempts: 2 });
    expect(['late', 'fast']).toContain(slow?.output);
    expect(attempts.get('flaky:k1')).toBe(3);

    // sleepUntil: parked on the absolute deadline, not before it.
    const sleeping = await runOf(cp.store, 'ops-1', (r) => r.status === 'suspended');
    expect(sleeping.wakeAt).toBe(wakeAt);
    const timer = (await cp.store.listCheckpoints('ops-1')).find((c) => c.kind === 'sleep');
    expect(timer?.wakeAt).toBe(wakeAt);

    // After the deadline: the child is started without being awaited, the bounded signal wait
    // times out, and the run waits for the event.
    await until(
      () => cp.engine.getEvent('ops-1', 'stage'),
      (stage) => stage === 'awaiting-payment',
    );
    expect(Date.now()).toBeGreaterThanOrEqual(wakeAt);
    await until(
      () => cp.store.listSignalWaiters(eventPrefix('order.paid')),
      (waiters) => waiters.some((w) => w.runId === 'ops-1'),
    );
    // A signal sent after the timeout is not delivered to the wait that timed out.
    await cp.engine.signal('approve-k1', 'too-late');

    const kid = await runOf(cp.store, 'ops-1-kid', (r) => r.status === 'completed');
    expect(kid.output).toBe(40);
    expect(kid.namespace).toBe('acme');

    // A publish for another key does not match; the one for this key resumes the run.
    await cp.engine.publishEvent('order.paid', { key: 'other', total: 1 }, { buffer: false });
    await cp.engine.publishEvent('order.paid', { key: 'k1', total: 9 });
    const done = await runOf(cp.store, 'ops-1', (r) => r.status === 'completed');
    expect(done.output).toEqual({
      flaky: 3,
      slow: slow?.output,
      approval: 'timed-out',
      paid: { key: 'k1', total: 9 },
      childId: 'ops-1-kid',
    });
    expect(await cp.engine.getEvent('ops-1', 'stage')).toBe('awaiting-payment');
  }, 90_000);

  it('continueAsNew completes the run and continues it on the tenant', async (ctx) => {
    const conn = live(ctx);
    const prefix = `durtest-tenant-can-${Date.now()}`;
    const cp = controlPlane(conn, prefix);
    closers.push(cp.close);
    const tenant = await tenantApp(conn, prefix);
    closers.push(() => tenant.close());
    await until(
      () => cp.transport.listWorkerGroups(),
      (groups) => groups.includes('ops-counter@acme'),
      45_000,
    );

    await CounterWorkflow.start({ n: 0 }, { id: 'count-1' });
    const first = await runOf(cp.store, 'count-1', (r) => r.status === 'completed');
    expect(first.output).toBeUndefined();
    const last = await until(
      () => cp.store.listRuns({}),
      (runs) => runs.some((r) => r.workflow === 'ops-counter' && r.output === 2),
    );
    const chain = last.filter((r) => r.workflow === 'ops-counter');
    expect(chain).toHaveLength(3);
    expect(chain.every((r) => r.status === 'completed' && r.namespace === 'acme')).toBe(true);
    expect(chain.every((r) => r.id.startsWith('count-1'))).toBe(true);
  }, 90_000);
});
