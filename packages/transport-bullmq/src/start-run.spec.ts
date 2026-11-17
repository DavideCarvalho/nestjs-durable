import { describe, expect, it, vi } from 'vitest';

/**
 * P4.1 — `dispatchStartRun` / `onStartRun` contract for BullMQTransport.
 *
 * All tests are OFFLINE: bullmq and ioredis are mocked so we assert the exact queue names and
 * wire payloads without a live Redis, following the same pattern as bullmq-namespace.spec.ts.
 *
 * Wire contract under test:
 *   - queue name  : `<effectivePrefix>-start-run`
 *   - job name    : `'startRun'`
 *   - payload     : a StartRunMessage — `{ tenant, workflow, input, runId?, tags? }`
 */

const capturedQueues: Array<{ name: string }> = [];
const capturedWorkers: Array<{ name: string }> = [];
let capturedProcessor: ((job: { data: unknown }) => Promise<unknown>) | undefined;
const capturedJobAdds: Array<{
  queue: string;
  jobName: string;
  data: unknown;
  opts?: Record<string, unknown> | undefined;
}> = [];

vi.mock('bullmq', () => ({
  Queue: vi.fn((name: string) => {
    capturedQueues.push({ name });
    return {
      add: vi.fn(async (jobName: string, data: unknown, opts?: Record<string, unknown>) => {
        capturedJobAdds.push({ queue: name, jobName, data, opts });
      }),
      close: vi.fn().mockResolvedValue(undefined),
      getJobCounts: vi.fn().mockResolvedValue({}),
    };
  }),
  Worker: vi.fn((name: string, processor: (job: { data: unknown }) => Promise<unknown>) => {
    capturedWorkers.push({ name });
    capturedProcessor = processor;
    return { concurrency: 1, close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    scan: vi.fn().mockResolvedValue(['0', []]),
    disconnect: vi.fn(),
    duplicate: vi.fn(),
  })),
}));

const { BullMQTransport } = await import('./bullmq-transport');

const connection = { host: '127.0.0.1', port: 6379 };

function resetCaptures() {
  capturedQueues.length = 0;
  capturedWorkers.length = 0;
  capturedJobAdds.length = 0;
  capturedProcessor = undefined;
}

describe('BullMQTransport — dispatchStartRun', () => {
  it('enqueues onto <prefix>-start-run (default prefix)', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection });
    await transport.dispatchStartRun({ tenant: 'acme', workflow: 'checkout', input: { qty: 2 } });
    await transport.close();

    expect(capturedQueues.map((q) => q.name)).toContain('durable-start-run');
    const added = capturedJobAdds.find((a) => a.queue === 'durable-start-run');
    expect(added).toBeDefined();
    expect(added?.jobName).toBe('startRun');
  });

  it('enqueues the full StartRunMessage payload verbatim', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection });
    const msg = {
      tenant: 'acme',
      workflow: 'invoice',
      input: { orderId: 'o-42' },
      runId: 'run-123',
      tags: ['priority', 'batch'],
    };
    await transport.dispatchStartRun(msg);
    await transport.close();

    const added = capturedJobAdds.find((a) => a.queue === 'durable-start-run');
    expect(added?.data).toEqual(msg);
  });

  it('respects a non-default namespace in the queue name', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection, namespace: 'dev-alice' });
    await transport.dispatchStartRun({ tenant: 'dev-alice', workflow: 'wf', input: null });
    await transport.close();

    expect(capturedQueues.map((q) => q.name)).toContain('durable-dev-alice-start-run');
    expect(capturedQueues.map((q) => q.name)).not.toContain('durable-start-run');
  });

  it('respects a custom prefix', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection, prefix: 'flip', namespace: 'dev-bob' });
    await transport.dispatchStartRun({ tenant: 'dev-bob', workflow: 'wf', input: null });
    await transport.close();

    expect(capturedQueues.map((q) => q.name)).toContain('flip-dev-bob-start-run');
  });

  it('"default" namespace stays byte-identical to the un-namespaced scheme', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection, namespace: 'default' });
    await transport.dispatchStartRun({ tenant: 'acme', workflow: 'wf', input: null });
    await transport.close();

    expect(capturedQueues.map((q) => q.name)).toContain('durable-start-run');
    expect(capturedQueues.map((q) => q.name)).not.toContain('durable-default-start-run');
  });
});

describe('BullMQTransport — onStartRun', () => {
  it('starts a consumer on <prefix>-start-run and routes messages to the handler', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection });
    const received: unknown[] = [];
    transport.onStartRun(async (msg) => {
      received.push(msg);
    });

    expect(capturedWorkers.map((w) => w.name)).toContain('durable-start-run');

    const msg = { tenant: 'acme', workflow: 'checkout', input: { qty: 1 } };
    await capturedProcessor?.({ data: msg });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);

    await transport.close();
  });

  it('is idempotent — a second onStartRun call does not start a second consumer', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection });
    transport.onStartRun(async () => {});
    const workerCountBefore = capturedWorkers.filter((w) => w.name === 'durable-start-run').length;
    transport.onStartRun(async () => {}); // second call — must be no-op
    const workerCountAfter = capturedWorkers.filter((w) => w.name === 'durable-start-run').length;
    expect(workerCountAfter).toBe(workerCountBefore);
    await transport.close();
  });

  it('consumer uses the namespaced queue name', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection, namespace: 'dev-carol' });
    transport.onStartRun(async () => {});
    expect(capturedWorkers.map((w) => w.name)).toContain('durable-dev-carol-start-run');
    await transport.close();
  });
});

describe('BullMQTransport — onStartRun redelivery', () => {
  it('re-enqueues a start the handler failed on, with a delay, and strips the counter before the handler', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection });
    const seen: unknown[] = [];
    let fail = true;
    transport.onStartRun(async (msg) => {
      seen.push(msg);
      if (fail) throw new Error('store blip');
    });
    const processor = capturedProcessor;
    if (!processor) throw new Error('no start-run consumer');
    const msg = { tenant: 'acme', workflow: 'invoice', input: {}, runId: 'r1' };

    // Was: the error failed the job, and `removeOnFail` dropped the start for good.
    await processor({ data: msg });
    const retry = capturedJobAdds.find((a) => a.queue === 'durable-start-run');
    expect(retry?.data).toMatchObject({ ...msg, __redelivery: 1 });
    expect(retry?.opts?.delay).toBe(1_000);

    // The redelivery reaches the handler as the original message, and succeeds.
    fail = false;
    await processor({ data: retry?.data });
    expect(seen).toEqual([msg, msg]);
    expect(capturedJobAdds.filter((a) => a.queue === 'durable-start-run')).toHaveLength(1);
    await transport.close();
  });

  it('gives up after the redelivery cap instead of looping forever', async () => {
    resetCaptures();
    const transport = new BullMQTransport({ connection });
    transport.onStartRun(async () => {
      throw new Error('poison');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await capturedProcessor?.({
      data: { tenant: 'acme', workflow: 'invoice', input: {}, __redelivery: 60 },
    });
    expect(capturedJobAdds.filter((a) => a.queue === 'durable-start-run')).toHaveLength(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    await transport.close();
  });
});
