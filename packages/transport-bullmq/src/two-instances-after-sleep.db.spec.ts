import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * Two instances on one store and a real Redis, with short sleeps, so a due run is handed off, delivered and
 * executed at every wake. A step of a run must never execute on both at once. Uses `DURABLE_TEST_REDIS_URL`
 * when set, else a testcontainer. Run with `pnpm test:db`.
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('two instances and a run woken from a sleep', () => {
  it('never execute one step of a run together', async () => {
    const RUNS = Number(process.env.TWO_INSTANCE_RUNS ?? 60);
    const prefix = `two-${Math.random().toString(36).slice(2)}`;
    const store = new InMemoryStateStore();
    const active = new Map<string, number>();
    let overlaps = 0;
    const flow = async (ctx: {
      runId: string;
      sleep: (ms: number) => Promise<void>;
      localStep: (n: string, f: () => Promise<number>) => Promise<number>;
    }) => {
      for (let i = 0; i < 4; i++) {
        await ctx.localStep(`step-${i}`, async () => {
          const key = `${ctx.runId}:${i}`;
          const n = (active.get(key) ?? 0) + 1;
          active.set(key, n);
          if (n > 1) overlaps++;
          await delay(25);
          active.set(key, (active.get(key) ?? 1) - 1);
          return i;
        });
        await ctx.sleep(20);
      }
      return 'done';
    };
    // A real store answers in milliseconds, which is what gives a race its window.
    const slow = new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await delay(Math.random() * 6);
          return value.apply(target, args);
        };
      },
    });
    const make = (id: string) => {
      const transport = new BullMQTransport({
        connection: new Redis({ ...base, maxRetriesPerRequest: null }) as never,
        prefix,
        instanceId: id,
        concurrency: 8,
      } as never);
      const engine = new WorkflowEngine({
        store: slow,
        transport,
        instanceId: id,
        timerPollMs: 10,
        leaseMs: 30_000,
      } as never);
      engine.register('flow', '1', flow as never);
      return engine;
    };
    const a = make('a');
    const b = make('b');
    a.consumeRuns();
    b.consumeRuns();
    const pollers = [a, b].map((engine) =>
      setInterval(() => void engine.resumeDueTimers().catch(() => undefined), 10),
    );
    for (let i = 0; i < RUNS; i++) await a.start('flow', {}, `r${i}`);
    const until = Date.now() + 120_000;
    let open = RUNS;
    while (open > 0 && Date.now() < until) {
      await delay(200);
      const runs = await Promise.all(Array.from({ length: RUNS }, (_, i) => store.getRun(`r${i}`)));
      open = runs.filter((r) => r?.status !== 'completed' && r?.status !== 'failed').length;
    }
    for (const poller of pollers) clearInterval(poller);
    const runs = await Promise.all(Array.from({ length: RUNS }, (_, i) => store.getRun(`r${i}`)));
    const failed = runs.filter((r) => r?.status === 'failed').map((r) => r?.error?.code);
    await Promise.allSettled([a.drain?.(), b.drain?.()]);
    console.log(`two instances: overlaps ${overlaps}, failed ${failed.length}, open ${open}`);
    expect(failed).toEqual([]);
    expect(overlaps).toBe(0);
    expect(open).toBe(0);
  }, 180_000);
});
