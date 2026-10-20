import { describe, expect, it } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * Nothing listens on this port, so every subscriber connection is still connecting when `close()`
 * runs. ioredis holds each `subscribe` in its offline queue and rejects it with "Connection is
 * closed." on disconnect. Those rejections must not escape as `unhandledRejection`.
 */
describe('BullMQTransport.close() while subscribers are still connecting', () => {
  it('[close-during-subscribe] raises no unhandled rejection from the queued subscribes', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const transport = new BullMQTransport({
        connection: { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null },
        pingIntervalMs: 0,
        closeTimeoutMs: 1_000,
      });
      transport.onControl(() => {});
      transport.onHeartbeat(async () => {});
      transport.onRunReply(() => {});
      const unsubscribe = transport.onTenantEvent('acme', () => {});
      unsubscribe(); // disconnects the per-tenant subscriber the same tick
      await transport.close();
      await new Promise((r) => setTimeout(r, 200));
      expect(rejections.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
