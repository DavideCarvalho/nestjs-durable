import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fixed `concurrency` that is non-finite or below 1 falls back to 1 instead of reaching the BullMQ
 * Worker, which throws on such a value. Offline: `bullmq`/`ioredis` mocked.
 */

const captured = vi.hoisted(() => ({ concurrency: [] as unknown[] }));

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({}),
  })),
  Worker: vi.fn((_queue: string, _processor: unknown, opts: { concurrency?: unknown }) => {
    captured.concurrency.push(opts.concurrency);
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

const { BullMQTransport } = await import('./bullmq-transport');
type Concurrency = ConstructorParameters<typeof BullMQTransport>[0]['concurrency'];

function workerConcurrency(concurrency: Concurrency): unknown {
  const transport = new BullMQTransport({
    connection: { host: '127.0.0.1', port: 6379 },
    concurrency,
  });
  transport.handle('step', async () => undefined);
  return captured.concurrency.at(-1);
}

describe('BullMQTransport concurrency', () => {
  beforeEach(() => {
    captured.concurrency.length = 0;
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 0.5])(
    'falls back to 1 for a fixed %s',
    (value) => {
      expect(workerConcurrency(value)).toBe(1);
    },
  );

  it('keeps a valid fixed value, floored', () => {
    expect(workerConcurrency(8)).toBe(8);
    expect(workerConcurrency(4.7)).toBe(4);
  });

  it('starts an adaptive worker at the default floor when min and start are non-finite', () => {
    expect(workerConcurrency({ mode: 'adaptive', min: Number.NaN, start: Number.NaN })).toBe(1);
  });
});
