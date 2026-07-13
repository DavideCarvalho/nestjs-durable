import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * OFFLINE unit coverage for the shared pub/sub subscriber ping watchdog (`bullmq-transport.ts`'s
 * `startPingWatchdog`/`pingSubscriber`) — specifically the parts that don't need a live Redis:
 * the watchdog is a SINGLE shared `setInterval`, `pingIntervalMs: 0 | false` disables it entirely,
 * and `close()` always clears it (a leaked interval would hang vitest / keep a process alive).
 * The actual kill → detect → reconnect → resubscribe cycle against a real broken connection is
 * covered by the real-Redis case in `bullmq-transport.db.spec.ts` (`heals a silently-dropped
 * RunReply subscriber connection …`), which is the only way to exercise real ioredis reconnect
 * behaviour; bullmq/ioredis are mocked here, following the same pattern as the other offline specs
 * in this package (e.g. `start-run.spec.ts`, `bullmq-namespace.spec.ts`).
 */

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({}),
  })),
  Worker: vi.fn(() => ({
    concurrency: 1,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
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

// Import AFTER the mocks are registered so the transport binds to the mocked bullmq/ioredis.
const { BullMQTransport } = await import('./bullmq-transport');
const connection = { host: '127.0.0.1', port: 6379 };

describe('BullMQTransport — subscriber ping watchdog lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts exactly one shared interval across several subscribers, and close() clears it', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    const transport = new BullMQTransport({ connection, pingIntervalMs: 50 });
    transport.onControl(() => {});
    transport.onHeartbeat(async () => {});
    transport.onRunReply(() => {});
    transport.onTenantEvent('acme', () => {});

    // Four subscriber connections (control/heartbeat/runReply/tenant), but ONE shared watchdog.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const [, intervalMs] = setIntervalSpy.mock.calls[0] ?? [];
    expect(intervalMs).toBe(50);
    const timer = setIntervalSpy.mock.results[0]?.value;

    await transport.close();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it('never starts the watchdog when pingIntervalMs is disabled (false or 0)', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const disabledByFalse = new BullMQTransport({ connection, pingIntervalMs: false });
    disabledByFalse.onControl(() => {});
    const disabledByZero = new BullMQTransport({ connection, pingIntervalMs: 0 });
    disabledByZero.onHeartbeat(async () => {});

    expect(setIntervalSpy).not.toHaveBeenCalled();

    await disabledByFalse.close();
    await disabledByZero.close();
  });

  it('close() is safe to call when no subscriber was ever registered (no watchdog to leak)', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const transport = new BullMQTransport({ connection });

    await expect(transport.close()).resolves.toBeUndefined();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });
});
