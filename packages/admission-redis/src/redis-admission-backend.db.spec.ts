import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisAdmissionBackend } from './redis-admission-backend';

/**
 * Real-Redis matrix for the global admission gate (Docker via testcontainers; run with `pnpm test:db`).
 * Self-skips cleanly when Docker is unavailable or SKIP_TESTCONTAINERS is set.
 */
const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;

let container: StartedRedisContainer | undefined;
let redis: Redis | undefined;

beforeAll(async () => {
  if (skipped) return;
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis({ host: container.getHost(), port: container.getFirstMappedPort() });
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

function maybe(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (skipped || !redis) return;
    await redis.flushall();
    await fn();
  });
}

describe('RedisAdmissionBackend — global flow control', () => {
  maybe('caps concurrency across separate backend instances (separate "pods")', async () => {
    if (!redis) return;
    const podA = new RedisAdmissionBackend({ connection: redis, prefix: 't' });
    const podB = new RedisAdmissionBackend({ connection: redis, prefix: 't' });
    const config = { name: 'q', concurrency: 1 };
    podA.register(config);
    podB.register(config);

    const a = await podA.tryAdmit('q', { waiterId: 'A' });
    const b = await podB.tryAdmit('q', { waiterId: 'B' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false); // global cap of 1 is honored across pods, not 1-per-pod

    await podA.release('q', 'A');
    const b2 = await podB.tryAdmit('q', { waiterId: 'B' });
    expect(b2.ok).toBe(true);
  });

  maybe('enforces a fixed-window rate limit globally', async () => {
    if (!redis) return;
    let now = 1_000_000;
    const backend = new RedisAdmissionBackend({
      connection: redis,
      prefix: 't',
      clock: () => now,
    });
    backend.register({ name: 'q', rateLimit: { limit: 2, periodMs: 1000 } });

    expect((await backend.tryAdmit('q', { waiterId: '1' })).ok).toBe(true);
    expect((await backend.tryAdmit('q', { waiterId: '2' })).ok).toBe(true);
    expect((await backend.tryAdmit('q', { waiterId: '3' })).ok).toBe(false); // window full

    now += 1001; // next window
    expect((await backend.tryAdmit('q', { waiterId: '4' })).ok).toBe(true);
  });

  maybe('auto-frees a slot whose lease expired (crash-safe)', async () => {
    if (!redis) return;
    let now = 1_000_000;
    const backend = new RedisAdmissionBackend({
      connection: redis,
      prefix: 't',
      leaseMs: 5000,
      clock: () => now,
    });
    backend.register({ name: 'q', concurrency: 1 });

    expect((await backend.tryAdmit('q', { waiterId: 'crashed' })).ok).toBe(true);
    // The holder "crashes" — never releases. Another acquire while the lease is live is blocked...
    expect((await backend.tryAdmit('q', { waiterId: 'next' })).ok).toBe(false);
    // ...but once the lease expires, the slot frees without an explicit release.
    now += 5001;
    expect((await backend.tryAdmit('q', { waiterId: 'next' })).ok).toBe(true);
  });

  maybe('admits the highest-priority waiter first when a slot frees', async () => {
    if (!redis) return;
    const backend = new RedisAdmissionBackend({ connection: redis, prefix: 't' });
    backend.register({ name: 'q', concurrency: 1 });

    expect((await backend.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
    // Two blocked waiters register; the higher priority should win the freed slot.
    expect((await backend.tryAdmit('q', { waiterId: 'low', priority: 1 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'high', priority: 9 })).ok).toBe(false);

    await backend.release('q', 'holder');
    // low retries first but must yield — it is not the best waiter.
    expect((await backend.tryAdmit('q', { waiterId: 'low', priority: 1 })).ok).toBe(false);
    // high retries and wins the slot.
    expect((await backend.tryAdmit('q', { waiterId: 'high', priority: 9 })).ok).toBe(true);
  });
});
