import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * The 30 s `drainDelay` default against a real Redis: it only spaces out the polls of IDLE queues.
 * A step dispatched to a worker idle for longer than BullMQ's old 5 s default is picked up at once
 * (BullMQ's marker wakes the blocked worker), a delayed job runs at its time, and closing idle
 * workers is not held up by the block. Uses `DURABLE_TEST_REDIS_URL` when set, else a
 * testcontainer. Run with `pnpm test:db`.
 */
const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
let container: StartedRedisContainer | undefined;
let connection: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (externalUrl) {
    const u = new URL(externalUrl);
    connection = { host: u.hostname, port: Number(u.port || 6379) };
    return;
  }
  container = await new RedisContainer('redis:7-alpine').start();
  connection = { host: container.getHost(), port: container.getFirstMappedPort() };
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(store: InMemoryStateStore, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (run && (run.status === 'completed' || run.status === 'failed')) return run;
    await delay(10);
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('BullMQ drainDelay 30 s (real Redis)', () => {
  it('a step sent to a worker idle past 5 s runs at once, and close is prompt', async () => {
    const prefix = `drain-${Math.random().toString(36).slice(2)}`;
    const transport = new BullMQTransport({ connection: connection as never, prefix });
    transport.handle('echo', async (input: { n: number }) => input.n);
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register('flow', '1', async (ctx) => ctx.step<number>('echo', { n: 7 }));
    // Every worker is now blocked on its empty queue for up to 30 s.
    await delay(6_000);
    const t0 = Date.now();
    await engine.start('flow', {}, 'r1');
    const run = await settle(store, 'r1');
    expect(run.output).toBe(7);
    expect(Date.now() - t0).toBeLessThan(2_000);
    // Idle again; closing must not wait out the 30 s block.
    await delay(1_000);
    const c0 = Date.now();
    await transport.close();
    expect(Date.now() - c0).toBeLessThan(3_000);
  }, 60_000);

  it('a delayed job on an idle queue runs at its time, not at the next 30 s poll', async () => {
    const name = `drain-delayed-${Math.random().toString(36).slice(2)}`;
    const ran: number[] = [];
    const worker = new Worker(name, async () => void ran.push(Date.now()), {
      connection: connection as never,
      drainDelay: 30,
    });
    const queue = new Queue(name, { connection: connection as never });
    await worker.waitUntilReady();
    await delay(1_000);
    const t0 = Date.now();
    await queue.add('j', {}, { delay: 2_000 });
    while (ran.length === 0 && Date.now() - t0 < 10_000) await delay(25);
    expect(ran).toHaveLength(1);
    expect((ran[0] as number) - t0).toBeLessThan(3_500);
    const c0 = Date.now();
    await Promise.all([worker.close(), queue.close()]);
    expect(Date.now() - c0).toBeLessThan(3_000);
  }, 30_000);
});
