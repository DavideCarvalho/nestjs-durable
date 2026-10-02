import { setImmediate } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { RedisAdmissionBackend } from './redis-admission-backend';

describe('RedisAdmissionBackend startup liveness', () => {
  it('handles a failed first heartbeat and retries on the next heartbeat', async () => {
    const redis = new Redis({ lazyConnect: true });
    const set = vi
      .spyOn(redis, 'set')
      .mockRejectedValueOnce(new Error('Redis disconnected'))
      .mockResolvedValue('OK');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.useFakeTimers();
    let backend: RedisAdmissionBackend | undefined;
    try {
      backend = new RedisAdmissionBackend({ connection: redis, instanceTtlMs: 3000 });
      await setImmediate();
      expect(unhandled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(set).toHaveBeenCalledTimes(2);
    } finally {
      await backend?.close();
      vi.useRealTimers();
      process.off('unhandledRejection', unhandled);
      set.mockRestore();
      redis.disconnect();
    }
  });
});
