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
const backends: RedisAdmissionBackend[] = [];

beforeAll(async () => {
  if (skipped) return;
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis({ host: container.getHost(), port: container.getFirstMappedPort() });
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  for (const b of backends) await b.close();
  redis?.disconnect();
  await container?.stop();
});

function makeBackend(opts: Partial<ConstructorParameters<typeof RedisAdmissionBackend>[0]> = {}) {
  const backend = new RedisAdmissionBackend({
    connection: redis as Redis,
    prefix: 't',
    ...opts,
  });
  backends.push(backend);
  return backend;
}

function maybe(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (skipped || !redis) return;
    await redis.flushall();
    await fn();
  });
}

describe('RedisAdmissionBackend — global flow control', () => {
  maybe('caps concurrency across separate "pods" (instances)', async () => {
    const podA = makeBackend({ instanceId: 'A' });
    const podB = makeBackend({ instanceId: 'B' });
    const config = { name: 'q', concurrency: 1 };
    podA.register(config);
    podB.register(config);

    expect((await podA.tryAdmit('q', { waiterId: 'wa' })).ok).toBe(true);
    expect((await podB.tryAdmit('q', { waiterId: 'wb' })).ok).toBe(false);

    await podA.release('q', 'wa');
    expect((await podB.tryAdmit('q', { waiterId: 'wb' })).ok).toBe(true);
  });

  maybe('enforces a fixed-window rate limit globally', async () => {
    let now = 1_000_000;
    const backend = makeBackend({ clock: () => now });
    backend.register({ name: 'q', rateLimit: { limit: 2, periodMs: 1000 } });

    expect((await backend.tryAdmit('q', { waiterId: '1' })).ok).toBe(true);
    expect((await backend.tryAdmit('q', { waiterId: '2' })).ok).toBe(true);
    expect((await backend.tryAdmit('q', { waiterId: '3' })).ok).toBe(false);

    now += 1001;
    expect((await backend.tryAdmit('q', { waiterId: '4' })).ok).toBe(true);
  });

  maybe("reclaims a dead instance's slot (liveness-based, not time-lease)", async () => {
    const podA = makeBackend({ instanceId: 'deadpod' });
    const podB = makeBackend({ instanceId: 'livepod' });
    const config = { name: 'q', concurrency: 1 };
    podA.register(config);
    podB.register(config);

    expect((await podA.tryAdmit('q', { waiterId: 'held' })).ok).toBe(true);
    expect((await podB.tryAdmit('q', { waiterId: 'want' })).ok).toBe(false);

    // Pod A "crashes": stop its liveness heartbeat and drop its liveness key.
    await podA.close();
    await (redis as Redis).del('t:adm:inst:deadpod');

    // Pod B reclaims the orphaned slot — no time-based lease needed.
    expect((await podB.tryAdmit('q', { waiterId: 'want' })).ok).toBe(true);
  });

  maybe("does NOT reclaim a live instance's slot, however long the step runs", async () => {
    const podA = makeBackend({ instanceId: 'liveA', instanceTtlMs: 1000 });
    const podB = makeBackend({ instanceId: 'liveB' });
    const config = { name: 'q', concurrency: 1 };
    podA.register(config);
    podB.register(config);

    expect((await podA.tryAdmit('q', { waiterId: 'long' })).ok).toBe(true);
    // Wait well past the instance TTL — the heartbeat keeps A's liveness fresh, so the slot stays held.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await podB.tryAdmit('q', { waiterId: 'want' })).ok).toBe(false);
  });

  maybe('admits the highest-priority waiter first when a slot frees', async () => {
    const backend = makeBackend();
    backend.register({ name: 'q', concurrency: 1 });

    expect((await backend.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
    expect((await backend.tryAdmit('q', { waiterId: 'low', priority: 1 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'high', priority: 9 })).ok).toBe(false);

    await backend.release('q', 'holder');
    expect((await backend.tryAdmit('q', { waiterId: 'low', priority: 1 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'high', priority: 9 })).ok).toBe(true);
  });

  maybe('breaks equal-priority ties by arrival order (FIFO)', async () => {
    const backend = makeBackend();
    backend.register({ name: 'q', concurrency: 1 });

    expect((await backend.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
    // first and second arrive in this order, same priority.
    expect((await backend.tryAdmit('q', { waiterId: 'first', priority: 5 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'second', priority: 5 })).ok).toBe(false);

    await backend.release('q', 'holder');
    // second retries first but must yield to the earlier arrival.
    expect((await backend.tryAdmit('q', { waiterId: 'second', priority: 5 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'first', priority: 5 })).ok).toBe(true);
  });

  maybe('admits the most-recent arrival first within equal priority when order is LIFO', async () => {
    const backend = makeBackend();
    backend.register({ name: 'q', concurrency: 1, order: 'lifo' });

    expect((await backend.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
    expect((await backend.tryAdmit('q', { waiterId: 'first', priority: 5 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'second', priority: 5 })).ok).toBe(false);

    await backend.release('q', 'holder');
    // LIFO: the later arrival wins; the earlier one keeps waiting.
    expect((await backend.tryAdmit('q', { waiterId: 'first', priority: 5 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'second', priority: 5 })).ok).toBe(true);
  });

  maybe('round-robins a contended slot across fairness keys (no key monopolizes)', async () => {
    const backend = makeBackend();
    backend.register({ name: 'q', concurrency: 1, fairness: 'key' });

    // Tenant A holds the slot, and has TWO more queued; tenant B has one queued.
    expect((await backend.tryAdmit('q', { waiterId: 'a0', key: 'A' })).ok).toBe(true);
    expect((await backend.tryAdmit('q', { waiterId: 'a1', key: 'A' })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'a2', key: 'A' })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'b0', key: 'B' })).ok).toBe(false);

    await backend.release('q', 'a0');
    // B (never served) should win over A (just served), not FIFO order.
    expect((await backend.tryAdmit('q', { waiterId: 'a1', key: 'A' })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'b0', key: 'B' })).ok).toBe(true);
  });

  maybe('publishes a freed-slot signal on release that onFreed subscribers receive', async () => {
    const releaser = makeBackend({ instanceId: 'rel' });
    const watcher = makeBackend({ instanceId: 'watch' });
    releaser.register({ name: 'q', concurrency: 1 });

    const freed: string[] = [];
    watcher.onFreed((queue) => freed.push(queue));
    await new Promise((r) => setTimeout(r, 100)); // let the subscription establish

    await releaser.tryAdmit('q', { waiterId: 'held' });
    await releaser.release('q', 'held');
    await new Promise((r) => setTimeout(r, 100)); // let the message propagate

    expect(freed).toContain('q');
  });

  maybe('prunes a waiter that gave up so it cannot deadlock the others', async () => {
    let now = 1_000_000;
    const backend = makeBackend({ clock: () => now, retryMs: 100 });
    backend.register({ name: 'q', concurrency: 1 });

    expect((await backend.tryAdmit('q', { waiterId: 'holder' })).ok).toBe(true);
    // A high-priority waiter registers, then "gives up" (its run was cancelled — never retries).
    expect((await backend.tryAdmit('q', { waiterId: 'ghost', priority: 100 })).ok).toBe(false);
    // A normal waiter keeps trying.
    expect((await backend.tryAdmit('q', { waiterId: 'real', priority: 1 })).ok).toBe(false);

    await backend.release('q', 'holder');
    // Time advances past the ghost's waiter TTL; it is pruned and `real` proceeds instead of yielding
    // to a phantom best-waiter forever.
    now += 10_000;
    expect((await backend.tryAdmit('q', { waiterId: 'real', priority: 1 })).ok).toBe(true);
  });
});
