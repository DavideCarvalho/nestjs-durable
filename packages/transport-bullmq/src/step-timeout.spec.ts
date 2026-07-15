import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `stepTimeoutMs` — the wedged-handler ceiling, exercised OFFLINE (`bullmq`/`ioredis` mocked). A
 * handler await that will never settle (dead connection swallowed by a wrapper stream) otherwise
 * holds its BullMQ job forever: lock renewal is timer-based, so the job is never reclaimed and the
 * run waits until someone kills the process. With the ceiling set, the transport publishes a
 * RETRYABLE failed StepResult at the deadline and abandons the orphaned promise.
 */

const captured = vi.hoisted(() => ({
  adds: [] as { queue: string; name: string; data: unknown; opts: unknown }[],
  processors: [] as { queue: string; processor: (job: { data: unknown }) => Promise<void> }[],
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn((queueName: string) => ({
    add: vi.fn((name: string, data: unknown, opts: unknown) => {
      captured.adds.push({ queue: queueName, name, data, opts });
      return Promise.resolve(undefined);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({}),
  })),
  Worker: vi.fn((queueName: string, processor: (job: { data: unknown }) => Promise<void>) => {
    captured.processors.push({ queue: queueName, processor });
    return {
      concurrency: 1,
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    };
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

const remoteTask = (over: { runId: string; seq: number; name: string }) => ({
  runId: over.runId,
  seq: over.seq,
  stepId: `${over.runId}:${over.seq}`,
  name: over.name,
  group: over.name,
  input: {},
  attempt: 1,
});

const resultAdds = () => captured.adds.filter((a) => a.queue.endsWith('-results'));

describe('BullMQTransport — stepTimeoutMs wedged-handler ceiling', () => {
  beforeEach(() => {
    captured.adds.length = 0;
    captured.processors.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a handler that never settles fails RETRYABLE at the deadline instead of holding the job forever', async () => {
    const transport = new BullMQTransport({ connection, stepTimeoutMs: 5_000 });
    transport.handle('etl.ingest', () => new Promise(() => {})); // wedged forever

    const processor = captured.processors.find((p) => p.queue === 'durable-tasks-etl.ingest');
    expect(processor).toBeDefined();
    const running = processor?.processor({
      data: remoteTask({ runId: 'r1', seq: 0, name: 'etl.ingest' }),
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resultAdds()).toHaveLength(0); // still inside the ceiling — nothing published

    await vi.advanceTimersByTimeAsync(2);
    await running;
    const [result] = resultAdds();
    expect(result?.data).toMatchObject({
      runId: 'r1',
      seq: 0,
      status: 'failed',
      error: {
        message: expect.stringContaining('exceeded stepTimeoutMs'),
        retryable: true,
      },
    });
    await transport.close();
  });

  it('a handler finishing inside the ceiling publishes its own result (timer cleared)', async () => {
    const transport = new BullMQTransport({ connection, stepTimeoutMs: 5_000 });
    transport.handle('etl.quick', async () => ({ rows: 7 }));

    const processor = captured.processors.find((p) => p.queue === 'durable-tasks-etl.quick');
    const running = processor?.processor({
      data: remoteTask({ runId: 'r2', seq: 0, name: 'etl.quick' }),
    });
    await vi.advanceTimersByTimeAsync(1);
    await running;

    const [result] = resultAdds();
    expect(result?.data).toMatchObject({ runId: 'r2', status: 'completed' });
    expect(resultAdds()).toHaveLength(1);
    await transport.close();
  });

  it('no ceiling configured (default) leaves a wedged handler pending — previous behavior', async () => {
    const transport = new BullMQTransport({ connection });
    transport.handle('etl.legacy', () => new Promise(() => {}));

    const processor = captured.processors.find((p) => p.queue === 'durable-tasks-etl.legacy');
    void processor?.processor({ data: remoteTask({ runId: 'r3', seq: 0, name: 'etl.legacy' }) });

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(resultAdds()).toHaveLength(0);
    await transport.close();
  });
});
