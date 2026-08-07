import { describe, expect, it, vi } from 'vitest';

/**
 * OFFLINE regression coverage for `close()` when a BullMQ `Worker.close()` never settles.
 *
 * This is not hypothetical. A graceful `Worker.close()` waits for the current job AND for the
 * blocking connection to be released, and on a CPU-starved box (a 2-vCPU CI runner) that wait can
 * have no upper bound: measured across one run, 20 transports closed in 4-46ms (median 5ms) and 3
 * sat in `close()` for 120s — bimodal, never in between. Before this was bounded, the caller's
 * `await transport.close()` simply never returned, which stranded the whole shutdown chain above it
 * (the operator's `onApplicationShutdown`, and therefore `app.close()`).
 *
 * The wedge is modelled the only way it can be modelled offline: a worker whose `close()` returns a
 * promise that is never resolved. bullmq/ioredis are mocked, matching the other offline specs in
 * this package (`subscriber-watchdog.spec.ts`, `start-run.spec.ts`, `bullmq-namespace.spec.ts`).
 *
 * Note the mocked `Worker.close` deliberately does NOT model BullMQ's own memoization
 * (`if (this.closing) return this.closing`). That behaviour is why the fix cannot escalate to
 * `close(true)` — it is documented on `closeTimeoutMs` — but it is BullMQ's, not ours, so asserting
 * on it here would be testing the mock.
 */

const neverSettles = () => new Promise<void>(() => {});

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({}),
  })),
  // Every Worker this transport builds wedges on close.
  Worker: vi.fn(() => ({
    concurrency: 1,
    close: vi.fn(neverSettles),
    on: vi.fn(),
  })),
}));

const disconnect = vi.fn();

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
    disconnect,
    duplicate: vi.fn(),
  })),
}));

// Import AFTER the mocks are registered so the transport binds to the mocked bullmq/ioredis.
const { BullMQTransport } = await import('./bullmq-transport');
const connection = { host: '127.0.0.1', port: 6379 };

describe('BullMQTransport — close() with a wedged worker', () => {
  it('returns instead of hanging, and still drops the Redis connections', async () => {
    disconnect.mockClear();
    const transport = new BullMQTransport({
      connection,
      pingIntervalMs: false,
      closeTimeoutMs: 50,
    });
    // Build the workers whose close() never settles.
    transport.onControl(() => {});
    transport.handle('some-step', async () => ({}));

    const closed = await Promise.race([
      transport.close().then(() => 'closed' as const),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3_000)),
    ]);

    expect(closed).toBe('closed');
    // The point of bounding the wait: the disconnects sit AFTER it, and used to be unreachable
    // whenever a close wedged — which is what actually kept the sockets (and the process) alive.
    expect(disconnect).toHaveBeenCalled();
  });

  it('closeTimeoutMs: 0 skips the graceful wait entirely', async () => {
    disconnect.mockClear();
    const transport = new BullMQTransport({
      connection,
      pingIntervalMs: false,
      closeTimeoutMs: 0,
    });
    transport.onControl(() => {});
    transport.handle('some-step', async () => ({}));

    const started = Date.now();
    await transport.close();

    // No timer is scheduled at all on this path, so it must not spend even one timeout window.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(disconnect).toHaveBeenCalled();
  });
});
