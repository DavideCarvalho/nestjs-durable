import { DurableWorkerRuntime, runRedisWorker } from '@dudousxd/durable-worker';
import {
  InMemoryStateStore,
  RemoteWorkflowExecutor,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * A `ctx.step` with a retry policy, on a run whose turns are dispatched to a co-located
 * `@dudousxd/durable-worker` runtime that also consumes the step, over a real BullMQ with the run
 * queue on: a failed attempt is retried once its backoff passed, up to `retries`, as it is inline,
 * and not held until the lost-dispatch lease (`remoteRedispatchMs`) the step was dispatched with.
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

async function until(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met');
}

const SLOW_MS = 700;
const FLAKY = 'retry.flaky';
const STEP = Object.assign(() => {}, {
  [Symbol.for('durable.step.name')]: FLAKY,
});

/** Oracle's fence: a dropped turn write marks the run stale on this instance until it locks it again. */
function fence<T extends object>(inner: T, instanceId: string): T {
  const store = inner as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const stale = new Set<string>();
  const overrides: Record<string, unknown> = {
    async saveCheckpoint(cp: { runId: string; kind: string; seq: number; name: string }) {
      if (cp.kind === 'local' || cp.kind === 'sleep') {
        const run = (await store.getRun?.call(inner, cp.runId)) as { lockedBy?: string } | null;
        if (run?.lockedBy && run.lockedBy !== instanceId) {
          stale.add(cp.runId);
          return;
        }
      }
      await store.saveCheckpoint?.call(inner, cp);
    },
    async updateRunIf(runId: string, ...rest: unknown[]) {
      if (stale.has(runId)) return false;
      return store.updateRunIf?.call(inner, runId, ...rest);
    },
    async tryLockRun(runId: string, owner: string, ...rest: unknown[]) {
      const ok = await store.tryLockRun?.call(inner, runId, owner, ...rest);
      if (ok && owner === instanceId) stale.delete(runId);
      return ok;
    },
  };
  return new Proxy(inner, {
    get(target, key) {
      const own = typeof key === 'string' ? overrides[key] : undefined;
      if (own) return own;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function setup(handler: (input: unknown) => Promise<unknown>) {
  const prefix = `dsr-${Math.random().toString(36).slice(2)}`;
  const store = new InMemoryStateStore({ roundTripMethods: true });
  const body = async (ctx: { step: (...a: unknown[]) => Promise<unknown> }) =>
    ctx.step(STEP, {}, { retries: 3, backoff: 'exp', backoffMs: 200 });
  const engines: WorkflowEngine[] = [];
  for (const id of ['worker-a', 'api-b']) {
    const transport = new BullMQTransport({
      connection: { ...base, maxRetriesPerRequest: null } as never,
      prefix,
      instanceId: id,
      replyRouting: false,
    } as never);
    closers.push(() => transport.close());
    const engine = new WorkflowEngine({
      store: fence(store, id),
      transport,
      instanceId: id,
      namespace: 'oracle',
      remoteAdvanceSilenceMs: 30_000,
      // The lost-dispatch lease every dispatched step carries, far longer than the backoff.
      remoteRedispatchMs: 600_000,
      stickyRuns: 0,
      routeReplies: false,
    });
    engine.registerRemote('wf', '1', {
      group: 'wf',
      executor: new RemoteWorkflowExecutor(transport, 'wf'),
    });
    closers.push(() => engine.drain());
    engines.push(engine);
  }
  const [engine, api] = engines as [WorkflowEngine, WorkflowEngine];
  const stopRuns = engine.consumeRuns();
  if (stopRuns) closers.push(stopRuns);
  const runtime = new DurableWorkerRuntime({ workflowGroup: '' });
  runtime.registerWorkflow('wf', body as never);
  runtime.registerStep(FLAKY, handler as never);
  const running = await runRedisWorker({
    runtime,
    connection: `redis://${base?.host}:${base?.port}`,
    prefix,
    lockDuration: 30_000,
    maxStalledCount: 0,
  });
  closers.push(() => running.close());
  // The timer poll a driving module runs (the api role does not drive).
  let polling = true;
  const poll = (async () => {
    while (polling) {
      await engine.resumeDueTimers().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  closers.push(async () => {
    polling = false;
    await poll;
  });
  return { store, engine: api };
}

describe('a dispatched ctx.step with retries on a real BullMQ', () => {
  it('retries a failed attempt after its backoff, and the run completes on the third', async () => {
    let attempts = 0;
    const env = await setup(async () => {
      attempts += 1;
      await new Promise((r) => setTimeout(r, SLOW_MS));
      if (attempts < 3) throw new Error(`wedged ${attempts}`);
      return 'ok';
    });
    await env.engine.start('wf', {}, 'r1');
    await until(async () => {
      const run = await env.store.getRun('r1');
      return run?.status === 'completed' || run?.status === 'failed';
    });
    const run = await env.store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('ok');
    expect(attempts).toBe(3);
    expect((await env.store.getCheckpoint('r1', 0))?.attempts).toBe(3);
  }, 60_000);

  it('fails the run with the last error once every attempt failed', async () => {
    let attempts = 0;
    const env = await setup(async () => {
      attempts += 1;
      await new Promise((r) => setTimeout(r, SLOW_MS));
      throw new Error(`down ${attempts}`);
    });
    await env.engine.start('wf', {}, 'r2');
    await until(async () => {
      const run = await env.store.getRun('r2');
      return run?.status === 'completed' || run?.status === 'failed';
    });
    const run = await env.store.getRun('r2');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toContain('down 3');
    expect(attempts).toBe(3);
    expect((await env.store.getCheckpoint('r2', 0))?.attempts).toBe(3);
  }, 60_000);
});
