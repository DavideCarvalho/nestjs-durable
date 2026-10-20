import { describe, expect, it, vi } from 'vitest';

/**
 * `close()` must finish the workers before closing the queues. A worker's `close()` waits for the
 * job in flight, and that job publishes its result through a queue. Closing both at once let the
 * queue disconnect under the publish ("Connection is closed.") and lose the step result on SIGTERM.
 * The fakes model that: a queue rejects `add` once closed, and a worker's close() resolves only after
 * its in-flight job has tried to publish through the queue.
 */
const state = vi.hoisted(() => ({
  queueClosed: false,
  publishFailed: false,
  published: false,
  queue: undefined as { add: (...a: unknown[]) => Promise<void> } | undefined,
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => {
    const q = {
      add: vi.fn(async () => {
        if (state.queueClosed) {
          state.publishFailed = true;
          throw new Error('Connection is closed.');
        }
        state.published = true;
      }),
      close: vi.fn(async () => {
        state.queueClosed = true;
      }),
      getJobCounts: vi.fn().mockResolvedValue({}),
    };
    state.queue = q;
    return q;
  }),
  Worker: vi.fn(() => ({
    concurrency: 1,
    on: vi.fn(),
    // An in-flight job that finishes after the close was requested and then publishes its result.
    close: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      await state.queue?.add('result', {}).catch(() => {});
    }),
  })),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    status: 'ready',
    publish: vi.fn().mockResolvedValue(1),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    scan: vi.fn().mockResolvedValue(['0', []]),
    ping: vi.fn().mockResolvedValue('PONG'),
    on: vi.fn(),
    once: vi.fn(),
    disconnect: vi.fn(),
    duplicate: vi.fn(),
  })),
}));

const { BullMQTransport } = await import('./bullmq-transport');

describe('BullMQTransport.close() ordering', () => {
  it('[close-order] lets an in-flight job publish before the queues close', async () => {
    const transport = new BullMQTransport({
      connection: { host: '127.0.0.1', port: 6379 },
      pingIntervalMs: false,
      closeTimeoutMs: 2_000,
    });
    transport.handle('some-step', async () => ({}));
    await transport.dispatch({
      runId: 'r',
      seq: 0,
      name: 's',
      stepId: 'r:0',
      group: 'some-step',
      input: null,
      attempt: 1,
    });
    state.published = false;

    await transport.close();

    expect(state.publishFailed).toBe(false);
    expect(state.published).toBe(true);
    expect(state.queueClosed).toBe(true);
  });
});
