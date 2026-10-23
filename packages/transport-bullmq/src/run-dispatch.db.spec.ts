import { runRunDispatchContract } from '@dudousxd/nestjs-durable-testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * The shared run-dispatch contract against a real Redis (testcontainers): two BullMQTransports on
 * one fresh prefix per case stand for two instances of a deployment. Run with `pnpm test:db`; skips
 * when Docker is unavailable or `SKIP_TESTCONTAINERS` is set.
 */

let redis: StartedRedisContainer | undefined;
let unavailable: string | undefined;
let cases = 0;

beforeAll(async () => {
  if (process.env.SKIP_TESTCONTAINERS) {
    unavailable = 'SKIP_TESTCONTAINERS is set';
    return;
  }
  try {
    redis = await new RedisContainer('redis:7-alpine').start();
  } catch (err) {
    unavailable = `no Redis container: ${err instanceof Error ? err.message : String(err)}`;
  }
}, 180_000);

afterAll(async () => {
  await redis?.stop();
});

runRunDispatchContract('BullMQTransport (Redis)', async () => {
  if (unavailable || !redis) return unavailable ?? 'no Redis';
  const connection = { host: redis.getHost(), port: redis.getFirstMappedPort() };
  return {
    pair: async () => {
      cases += 1;
      const prefix = `rd${cases}-${Date.now()}`;
      return [
        new BullMQTransport({ connection, prefix }),
        new BullMQTransport({ connection, prefix }),
      ];
    },
  };
});
