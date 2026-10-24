import {
  STEP_FAN_STEP,
  runRunDispatchContract,
  runStepFanResultsContract,
} from '@dudousxd/nestjs-durable-testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll } from 'vitest';
import { BullMQTransport } from './bullmq-transport';

/**
 * The shared run-dispatch and step-fan-results contracts against a real Redis (testcontainers): two
 * BullMQTransports on one fresh prefix per case stand for two instances of a deployment. Run with
 * `pnpm test:db`; skips when Docker is unavailable or `SKIP_TESTCONTAINERS` is set. Uses
 * `DURABLE_TEST_REDIS_URL` when set.
 */

let redis: StartedRedisContainer | undefined;
let connection: { host: string; port: number } | undefined;
let unavailable: string | undefined;
let cases = 0;

beforeAll(async () => {
  // A shared Redis is fine: every case keys under its own prefix.
  const externalUrl = process.env.DURABLE_TEST_REDIS_URL;
  if (externalUrl) {
    const u = new URL(externalUrl);
    connection = { host: u.hostname, port: Number(u.port || 6379) };
    return;
  }
  if (process.env.SKIP_TESTCONTAINERS) {
    unavailable = 'SKIP_TESTCONTAINERS is set';
    return;
  }
  try {
    redis = await new RedisContainer('redis:7-alpine').start();
    connection = { host: redis.getHost(), port: redis.getFirstMappedPort() };
  } catch (err) {
    unavailable = `no Redis container: ${err instanceof Error ? err.message : String(err)}`;
  }
}, 180_000);

afterAll(async () => {
  await redis?.stop();
});

runRunDispatchContract('BullMQTransport (Redis)', async () => {
  if (unavailable || !connection) return unavailable ?? 'no Redis';
  const live = connection;
  return {
    pair: async () => {
      cases += 1;
      const prefix = `rd${cases}-${Date.now()}`;
      return [
        new BullMQTransport({ connection: live, prefix }),
        new BullMQTransport({ connection: live, prefix }),
      ];
    },
  };
});

runStepFanResultsContract('BullMQTransport (Redis)', async () => {
  if (unavailable || !connection) return unavailable ?? 'no Redis';
  const live = connection;
  return {
    open: async (handler) => {
      const connection = live;
      cases += 1;
      const prefix = `fr${cases}-${Date.now()}`;
      const worker = new BullMQTransport({ connection, prefix, concurrency: 64 });
      worker.handle(STEP_FAN_STEP, handler);
      const engines: [BullMQTransport, BullMQTransport] = [
        new BullMQTransport({ connection, prefix }),
        new BullMQTransport({ connection, prefix }),
      ];
      return {
        engines,
        close: async () => {
          await Promise.all([worker, ...engines].map((t) => t.close()));
        },
      };
    },
  };
});
