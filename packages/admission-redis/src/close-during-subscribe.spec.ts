import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { RedisAdmissionBackend } from './redis-admission-backend';

describe('RedisAdmissionBackend.close() while the freed-channel subscriber is connecting', () => {
  it('[close-during-subscribe] raises no unhandled rejection from the queued subscribe', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    // Nothing listens on port 1, so the duplicate is still connecting (its subscribe is queued).
    const redis = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, retryStrategy: null });
    try {
      const backend = new RedisAdmissionBackend({ connection: redis, instanceTtlMs: 3000 });
      backend.onFreed(() => {});
      await backend.close();
      await new Promise((r) => setTimeout(r, 200));
      expect(rejections.map(String)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      redis.disconnect();
    }
  });
});
