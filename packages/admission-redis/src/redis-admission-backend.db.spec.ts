import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisAdmissionBackend } from './redis-admission-backend';

/**
 * Redis-SPECIFIC behaviour of the global admission gate (Docker via testcontainers; run with
 * `pnpm test:db`). The backend-agnostic semantics (concurrency / rate / priority / FIFO / LIFO /
 * fairness) are pinned by the shared contract in `redis-admission-backend.conformance.db.spec.ts`;
 * this file covers only what's unique to the distributed backend: cross-pod globality, liveness-based
 * slot reclaim, the freed-slot pub/sub, and waiter pruning. Self-skips without Docker.
 */
const skipped = !!process.env.SKIP_TESTCONTAINERS;

let container: StartedRedisContainer | undefined;
let redis: Redis | undefined;
const backends: RedisAdmissionBackend[] = [];

beforeAll(async () => {
  if (skipped) return;
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis({ host: container.getHost(), port: container.getFirstMappedPort() });
}, 180_000);

afterAll(async () => {
  for (const b of backends) await b.close();
  redis?.disconnect();
  await container?.stop();
});

function makeBackend(opts: Partial<ConstructorParameters<typeof RedisAdmissionBackend>[0]> = {}) {
  const backend = new RedisAdmissionBackend({ connection: redis as Redis, prefix: 't', ...opts });
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

describe('RedisAdmissionBackend — distributed behaviour', () => {
  maybe('caps concurrency GLOBALLY across separate instances ("pods")', async () => {
    const podA = makeBackend({ instanceId: 'A' });
    const podB = makeBackend({ instanceId: 'B' });
    const config = { name: 'q', concurrency: 1 };
    podA.register(config);
    podB.register(config);

    expect((await podA.tryAdmit('q', { waiterId: 'wa' })).ok).toBe(true);
    expect((await podB.tryAdmit('q', { waiterId: 'wb' })).ok).toBe(false); // cap of 1 across pods
    await podA.release('q', 'wa');
    expect((await podB.tryAdmit('q', { waiterId: 'wb' })).ok).toBe(true);
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

    expect((await podB.tryAdmit('q', { waiterId: 'want' })).ok).toBe(true); // orphaned slot reclaimed
  });

  maybe("does NOT reclaim a live instance's slot, however long the step runs", async () => {
    const podA = makeBackend({ instanceId: 'liveA', instanceTtlMs: 1000 });
    const podB = makeBackend({ instanceId: 'liveB' });
    const config = { name: 'q', concurrency: 1 };
    podA.register(config);
    podB.register(config);

    expect((await podA.tryAdmit('q', { waiterId: 'long' })).ok).toBe(true);
    // Past the instance TTL — A's heartbeat keeps its liveness fresh, so the slot stays held.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await podB.tryAdmit('q', { waiterId: 'want' })).ok).toBe(false);
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
    // A high-priority waiter registers, then "gives up" (run cancelled — never retries).
    expect((await backend.tryAdmit('q', { waiterId: 'ghost', priority: 100 })).ok).toBe(false);
    expect((await backend.tryAdmit('q', { waiterId: 'real', priority: 1 })).ok).toBe(false);

    await backend.release('q', 'holder');
    // Past the ghost's waiter TTL it is pruned, so `real` proceeds instead of yielding forever.
    now += 10_000;
    expect((await backend.tryAdmit('q', { waiterId: 'real', priority: 1 })).ok).toBe(true);
  });
});
