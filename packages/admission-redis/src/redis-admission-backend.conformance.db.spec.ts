import { runAdmissionBackendContract } from '@dudousxd/nestjs-durable-testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll } from 'vitest';
import { RedisAdmissionBackend } from './redis-admission-backend';

/**
 * The shared cross-backend admission contract, run against a REAL Redis so the Redis backend's
 * ordering semantics are pinned identical to the in-process reference. Backend-specific behaviour
 * (leases, pub/sub, cross-pod globality) lives in `redis-admission-backend.db.spec.ts`.
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

if (!skipped) {
  runAdmissionBackendContract('RedisAdmissionBackend', (clock) => {
    if (!redis) throw new Error('redis not started');
    // Each contract case flushes via a fresh prefix so instances never share state across cases.
    const backend = new RedisAdmissionBackend({
      connection: redis,
      prefix: `c${backends.length}`,
      clock,
    });
    backends.push(backend);
    return backend;
  });
}
