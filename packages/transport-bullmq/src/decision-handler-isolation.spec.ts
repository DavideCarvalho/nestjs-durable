import { describe, expect, it, vi } from 'vitest';

/**
 * `onDecision` fans one decision out to every registered handler. With `Promise.all` the job failed
 * (and BullMQ redelivered it) the moment the FIRST handler rejected, while the others were still
 * running, so the redelivery ran them again concurrently with themselves, and only that first
 * failure was reported. Every handler must settle before the job fails.
 */

const captured = vi.hoisted(() => ({
  processors: [] as { queue: string; processor: (job: { data: unknown }) => Promise<void> }[],
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({}),
  })),
  Worker: vi.fn((queueName: string, processor: (job: { data: unknown }) => Promise<void>) => {
    captured.processors.push({ queue: queueName, processor });
    return { concurrency: 1, close: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
  }),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    status: 'ready',
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    once: vi.fn(),
    disconnect: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));

const { BullMQTransport } = await import('./bullmq-transport');

describe('BullMQTransport — onDecision handler isolation', () => {
  it('waits for every handler before failing the job, and reports every failure', async () => {
    const transport = new BullMQTransport({
      connection: { host: '127.0.0.1', port: 6379 },
      pingIntervalMs: false,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let slowDone = false;
    transport.onDecision(async () => {
      throw new Error('first');
    });
    transport.onDecision(async () => {
      await new Promise((r) => setTimeout(r, 30));
      slowDone = true;
    });
    transport.onDecision(async () => {
      throw new Error('second');
    });
    const proc = captured.processors.find((p) => p.queue.endsWith('decisions'));
    expect(proc).toBeDefined();
    let doneWhenFailed: boolean | undefined;
    await proc?.processor({ data: { runId: 'r', taskId: 't' } }).catch((err: Error) => {
      doneWhenFailed = slowDone;
      expect(err.message).toBe('first');
    });
    expect(doneWhenFailed).toBe(true); // the slow handler finished before the job failed
    expect(warn.mock.calls.some((c) => String(c[0]).includes('second'))).toBe(true);
    warn.mockRestore();
    await transport.close();
  });
});
