import { describe, expect, it, vi } from 'vitest';

/**
 * Liveness of the run-queue consumers (`onDispatchedRun`), offline: bullmq and ioredis are mocked, the
 * keys land in one shared map. An engine consuming the run queue executes workflow bodies, so the
 * Workers view must see it, but it takes no task queue and never wrote a worker heartbeat.
 */

const keys = new Map<string, string>();
const workers: {
  name: string;
  processor: (job: { data: unknown }) => Promise<unknown>;
}[] = [];

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({
    add: vi.fn(async () => undefined),
    addBulk: vi.fn(async () => undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  Worker: vi.fn(
    (
      name: string,
      processor: (job: { data: unknown }) => Promise<unknown>,
      opts: { concurrency?: number },
    ) => {
      workers.push({ name, processor });
      return {
        concurrency: opts.concurrency ?? 1,
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
      };
    },
  ),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    disconnect: vi.fn(),
    set: vi.fn(async (key: string, value: string) => {
      keys.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (keys.delete(key) ? 1 : 0)),
    scan: vi.fn(async (_cursor: string, _match: 'MATCH', pattern: string) => {
      const prefix = pattern.slice(0, -1); // `<prefix>*`
      return ['0', [...keys.keys()].filter((k) => k.startsWith(prefix))];
    }),
    mget: vi.fn(async (...wanted: string[]) => wanted.map((k) => keys.get(k) ?? null)),
  })),
}));

const { BullMQTransport } = await import('./bullmq-transport');

const connection = { host: '127.0.0.1', port: 6379 };

describe('BullMQTransport run-queue consumer liveness', () => {
  it('beats while consuming, and reports the instance with its load', async () => {
    keys.clear();
    workers.length = 0;
    const transport = new BullMQTransport({ connection, instanceId: 'ts-hub-1' });
    let release: () => void = () => undefined;
    const stop = transport.onDispatchedRun(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      { concurrency: 8 },
    );

    expect([...keys.keys()]).toEqual(['durable-runs-consumer:ts-hub-1']);
    const running = workers[0]?.processor({ data: { runId: 'r1' } });
    const [consumer] = await transport.liveRunConsumers();
    expect(consumer).toMatchObject({
      group: '',
      instanceId: 'ts-hub-1',
      status: { runtime: 'node', concurrency: { mode: 'fixed', limit: 8 }, inFlight: 0 },
    });
    expect(consumer?.lastBeatAt).toBeGreaterThan(0);

    release();
    await running;
    await stop();
    // A stopped consumer stops counting at once, not after the TTL.
    expect(await transport.liveRunConsumers()).toEqual([]);
    await transport.close();
  });

  it("reads only the asked namespace's run queue", async () => {
    keys.clear();
    const hub = new BullMQTransport({ connection, instanceId: 'ts-hub-1' });
    const local = new BullMQTransport({ connection, instanceId: 'ts-dev-1' });
    hub.onDispatchedRun(async () => undefined, { concurrency: 1 });
    local.onDispatchedRun(async () => undefined, { concurrency: 1, namespace: 'davi-local' });

    expect((await hub.liveRunConsumers()).map((c) => c.instanceId)).toEqual(['ts-hub-1']);
    expect(
      (await hub.liveRunConsumers({ namespace: 'davi-local' })).map((c) => c.instanceId),
    ).toEqual(['ts-dev-1']);
    await hub.close();
    await local.close();
  });

  it('does not beat while consumption is deferred, and does once consumers start', async () => {
    keys.clear();
    const transport = new BullMQTransport({
      connection,
      instanceId: 'ts-cli-1',
      deferConsumers: true,
    });
    transport.onDispatchedRun(async () => undefined, { concurrency: 1 });
    expect(await transport.liveRunConsumers()).toEqual([]);
    transport.startConsumers();
    expect((await transport.liveRunConsumers()).map((c) => c.instanceId)).toEqual(['ts-cli-1']);
    await transport.close();
  });

  it('never writes into the worker-heartbeat keyspace (convention routing reads it)', async () => {
    keys.clear();
    const transport = new BullMQTransport({ connection, instanceId: 'ts-hub-1' });
    transport.onDispatchedRun(async () => undefined, { concurrency: 1 });
    expect(await transport.listWorkerGroups()).toEqual([]);
    await transport.close();
  });
});
