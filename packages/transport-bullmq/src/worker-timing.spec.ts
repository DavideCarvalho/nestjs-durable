import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `drainDelay` and `stalledInterval` reach every BullMQ Worker the transport builds: `drainDelay`
 * defaults to 30 s, `stalledInterval` to BullMQ's own. Offline: `bullmq`/`ioredis` mocked.
 */

const captured = vi.hoisted(() => ({ opts: [] as Record<string, unknown>[] }));

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({}),
  })),
  Worker: vi.fn((_queue: string, _processor: unknown, opts: Record<string, unknown>) => {
    captured.opts.push(opts);
    return {
      concurrency: opts.concurrency,
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

const { BullMQTransport, DEFAULT_DRAIN_DELAY_SECONDS } = await import('./bullmq-transport');

function workerOptions(extra: { drainDelay?: number; stalledInterval?: number }) {
  captured.opts.length = 0;
  const transport = new BullMQTransport({
    connection: { host: '127.0.0.1', port: 6379 },
    ...extra,
  });
  transport.handle('step', async () => undefined);
  transport.handle('other', async () => undefined);
  return [...captured.opts];
}

beforeEach(() => {
  captured.opts.length = 0;
});

describe('BullMQ worker timing options', () => {
  it('drainDelay defaults to 30 s and stalledInterval to BullMQ default', () => {
    expect(DEFAULT_DRAIN_DELAY_SECONDS).toBe(30);
    const opts = workerOptions({});
    expect(opts.length).toBeGreaterThanOrEqual(2);
    for (const o of opts) {
      expect(o.drainDelay).toBe(30);
      expect('stalledInterval' in o).toBe(false);
    }
  });

  it('forwards both to every worker', () => {
    for (const o of workerOptions({ drainDelay: 12, stalledInterval: 90_000 })) {
      expect(o).toMatchObject({ drainDelay: 12, stalledInterval: 90_000 });
    }
  });

  it('a non-finite or non-positive value falls back', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const o of workerOptions({ drainDelay: bad, stalledInterval: bad })) {
        expect(o.drainDelay).toBe(30);
        expect('stalledInterval' in o).toBe(false);
      }
    }
  });
});
