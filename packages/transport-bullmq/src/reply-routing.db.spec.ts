import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import type { StepResult } from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * Routed replies on a real Redis: a dispatched step's result goes back to the engine instance that
 * dispatched it (and holds the body parked on it), and never gets lost when that instance is gone.
 * Uses `DURABLE_TEST_REDIS_URL` when set, else a testcontainer. Run with `pnpm test:db`.
 */
const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
let container: StartedRedisContainer | undefined;
let base: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (externalUrl) {
    const u = new URL(externalUrl);
    base = { host: u.hostname, port: Number(u.port || 6379) };
    return;
  }
  container = await new RedisContainer('redis:7-alpine').start();
  base = { host: container.getHost(), port: container.getFirstMappedPort() };
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met');
}

const STEP = Object.assign(() => {}, { [Symbol.for('durable.step.name')]: 'reply.add' });
const FAST = { replyAliveTtlMs: 600, replySweepMs: 100, replyDrainIdleMs: 1_000 };

function setup(prefix: string) {
  const store = new InMemoryStateStore({ roundTripMethods: true });
  let entries = 0;
  const transport = (id: string, opts: Record<string, unknown> = {}) => {
    const t = new BullMQTransport({
      connection: { ...base, maxRetriesPerRequest: null } as never,
      prefix,
      instanceId: id,
      ...FAST,
      ...opts,
    } as never);
    closers.push(() => t.close());
    return t;
  };
  const engine = (id: string, opts: Record<string, unknown> = {}) => {
    const t = transport(id, opts);
    const e = new WorkflowEngine({ store, transport: t, instanceId: id, reconcileMs: 0 });
    e.register('seq', '1', async (ctx, { n }: { n: number }) => {
      entries += 1;
      let total = 0;
      for (let i = 0; i < n; i += 1) total = await ctx.step<number>(STEP as never, total);
      return total;
    });
    return { engine: e, transport: t };
  };
  const worker = (id: string, opts: Record<string, unknown> = {}, gate?: () => Promise<void>) => {
    const t = transport(id, opts);
    t.handle('reply.add', async (input: unknown) => {
      await gate?.();
      return (input as number) + 1;
    });
    return t;
  };
  const sticky = (e: WorkflowEngine) =>
    (e as unknown as { sticky: { hits: number; misses: number } }).sticky;
  return { store, engine, worker, transport, sticky, entries: () => entries };
}

const completed = async (store: InMemoryStateStore, ids: string[]) =>
  (await Promise.all(ids.map((id) => store.getRun(id)))).every((r) => r?.status === 'completed');

describe('routed step results (BullMQ)', () => {
  it('go back to the engine that dispatched them, so no body replays', async () => {
    const env = setup(`rr-${Math.random().toString(36).slice(2)}`);
    const a = env.engine('engine-a');
    const b = env.engine('engine-b');
    env.worker('worker-1');
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = `r${i}`;
      ids.push(id);
      await (i % 2 ? b : a).engine.start('seq', { n: 5 }, id);
    }
    await until(() => completed(env.store, ids));
    for (const id of ids) expect((await env.store.getRun(id))?.output).toBe(5);
    // Each body ran once: every result reached the engine holding it.
    expect(env.entries()).toBe(6);
    expect(env.sticky(a.engine).hits + env.sticky(b.engine).hits).toBe(30);
  });

  it('without routing, results land on either engine and bodies replay (the control case)', async () => {
    const env = setup(`rr-${Math.random().toString(36).slice(2)}`);
    const a = env.engine('engine-a', { replyRouting: false });
    const b = env.engine('engine-b', { replyRouting: false });
    env.worker('worker-1');
    const ids = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5'];
    for (const [i, id] of ids.entries()) await (i % 2 ? b : a).engine.start('seq', { n: 5 }, id);
    await until(() => completed(env.store, ids));
    for (const id of ids) expect((await env.store.getRun(id))?.output).toBe(5);
    expect(env.entries()).toBeGreaterThan(6);
  });

  it('of an engine that died are moved to the shared results and finish the run elsewhere', async () => {
    const prefix = `rr-${Math.random().toString(36).slice(2)}`;
    const env = setup(prefix);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const a = env.engine('engine-a');
    const b = env.engine('engine-b');
    env.worker('worker-1', {}, () => gate);
    await a.engine.start('seq', { n: 2 }, 'd1');
    await until(async () => (await env.store.getRun('d1'))?.status === 'suspended');
    // Engine A crashes: it stops consuming and beating, without the goodbye a shutdown sends.
    const internals = a.transport as unknown as {
      replyBeatTimer: ReturnType<typeof setInterval>;
      replySweepTimer: ReturnType<typeof setInterval>;
      replyWorker: { close(): Promise<void> };
      resultsWorker: { close(): Promise<void> };
      resultBatchesWorker: { close(): Promise<void> };
    };
    clearInterval(internals.replyBeatTimer);
    clearInterval(internals.replySweepTimer);
    await Promise.all([
      internals.replyWorker.close(),
      internals.resultsWorker.close(),
      internals.resultBatchesWorker.close(),
    ]);
    // The step finishes while A's alive key still stands: its result goes to A's own queue.
    open();
    const queue = new Queue(`${prefix}-results-to-engine-a`, {
      connection: { ...base, maxRetriesPerRequest: null } as never,
    });
    closers.push(() => queue.close());
    await until(async () => (await queue.getWaitingCount()) === 1, 5_000);
    // Once the key lapses, B moves it to the shared results and finishes the run (replaying it).
    await until(async () => (await env.store.getRun('d1'))?.status === 'completed');
    expect((await env.store.getRun('d1'))?.output).toBe(2);
    expect(await queue.getWaitingCount()).toBe(0);
    expect(env.entries()).toBe(2);
  });

  it('settle a duplicate delivery once, whichever queue each copy came on', async () => {
    const prefix = `rr-${Math.random().toString(36).slice(2)}`;
    const env = setup(prefix);
    const a = env.engine('engine-a');
    const events: string[] = [];
    a.engine.subscribe((e) => {
      if (e.type === 'step.completed') events.push(`${e.runId}:${e.seq}`);
    });
    // No worker: the test delivers the result itself, twice, on both queues.
    await a.engine.start('seq', { n: 1 }, 'dup');
    await until(async () => (await env.store.getRun('dup'))?.status === 'suspended');
    const cp = (await env.store.listCheckpoints('dup'))[0];
    if (!cp) throw new Error('no checkpoint');
    const result: StepResult = {
      runId: 'dup',
      seq: cp.seq,
      stepId: cp.stepId ?? '',
      status: 'completed',
      output: 1,
    };
    const opts = { connection: { ...base, maxRetriesPerRequest: null } as never };
    const own = new Queue(`${prefix}-results-to-engine-a`, opts);
    const shared = new Queue(`${prefix}-results`, opts);
    closers.push(
      () => own.close(),
      () => shared.close(),
    );
    await Promise.all([own.add('result', result), shared.add('result', result)]);
    await until(async () => (await env.store.getRun('dup'))?.status === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual([`dup:${cp.seq}`]);
    expect((await env.store.getRun('dup'))?.output).toBe(1);
  });

  it('work in a rolling deploy mixing engines and workers that route replies and ones that do not', async () => {
    const env = setup(`rr-${Math.random().toString(36).slice(2)}`);
    const newer = env.engine('engine-new');
    const older = env.engine('engine-old', { replyRouting: false });
    env.worker('worker-new');
    env.worker('worker-old', { replyRouting: false });
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(`m${i}`);
      await (i % 2 ? older : newer).engine.start('seq', { n: 4 }, `m${i}`);
    }
    await until(() => completed(env.store, ids), 30_000);
    for (const id of ids) {
      expect((await env.store.getRun(id))?.output).toBe(4);
      // Every step settled once.
      const cps = await env.store.listCheckpoints(id);
      expect(cps.map((c) => [c.status, c.attempts])).toEqual(
        Array.from({ length: 4 }, () => ['completed', 1]),
      );
    }
  });
});
