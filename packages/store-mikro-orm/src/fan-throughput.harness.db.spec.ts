import { DURABLE_STEP_NAME, type StepRef, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { MikroORM } from '@mikro-orm/mysql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { ENTITIES } from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

/**
 * Throughput harness, not a regression test: a wide `ctx.all` step fan on MikroORM over a real
 * MySQL and BullMQ over a real Redis, across several engine instances (each with its own connection
 * pool) and as many worker transports. Prints one `HARNESS {...}` line: how long the dispatching
 * turn took, when the steps finished executing, when their results were all applied, and the store
 * calls that cost.
 *
 * Opt-in, and skipped otherwise (it starts nothing):
 *
 *   DURABLE_HARNESS=1 pnpm test:db packages/store-mikro-orm/src/fan-throughput.harness.db.spec.ts
 *
 * Knobs (environment): `H_FAN` steps (20000), `H_PODS` engine instances and workers (6),
 * `H_WORKER_CONCURRENCY` tasks per worker (8), `H_POOL` connections per instance (10),
 * `H_CONCURRENCY` the fan's `concurrency` (unset), `H_RESULT_CONCURRENCY` the transports'
 * `resultConcurrency` (unset). `DURABLE_HARNESS_MYSQL_URL` / `DURABLE_HARNESS_REDIS_URL` point it
 * at existing servers instead of testcontainers.
 */

const enabled = process.env.DURABLE_HARNESS === '1';
const num = (name: string, fallback?: number): number | undefined => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
};
const fan = num('H_FAN', 20_000) as number;
const pods = num('H_PODS', 6) as number;
const workerConcurrency = num('H_WORKER_CONCURRENCY', 8) as number;
const pool = num('H_POOL', 10) as number;
const concurrency = num('H_CONCURRENCY');
const resultConcurrency = num('H_RESULT_CONCURRENCY');

const STEP = 'harness-lines-process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = STEP;

let mysql: StartedMySqlContainer | undefined;
let redis: StartedRedisContainer | undefined;
let mysqlUrl = process.env.DURABLE_HARNESS_MYSQL_URL;
let redisConnection: { host: string; port: number } | undefined;

beforeAll(async () => {
  if (!enabled) return;
  const redisUrl = process.env.DURABLE_HARNESS_REDIS_URL;
  [mysql, redis] = await Promise.all([
    mysqlUrl ? undefined : new MySqlContainer('mysql:8.0').start(),
    redisUrl ? undefined : new RedisContainer('redis:7-alpine').start(),
  ]);
  if (mysql) {
    mysqlUrl = `mysql://${mysql.getUsername()}:${mysql.getUserPassword()}@${mysql.getHost()}:${mysql.getPort()}/${mysql.getDatabase()}`;
  }
  if (redisUrl) {
    const url = new URL(redisUrl);
    redisConnection = { host: url.hostname, port: Number(url.port || 6379) };
  } else if (redis) {
    redisConnection = { host: redis.getHost(), port: redis.getFirstMappedPort() };
  }
}, 300_000);

afterAll(async () => {
  await Promise.all([mysql?.stop(), redis?.stop()]);
});

describe.runIf(enabled)('wide step fan on MikroORM/MySQL + BullMQ/Redis (harness)', () => {
  it(`ctx.all over ${fan} steps on ${pods} instances`, async () => {
    const connection = redisConnection as { host: string; port: number };
    const prefix = `harness${Date.now()}`;
    const calls = new Map<string, number>();
    const busyMs = new Map<string, number>();
    const batches: number[] = [];
    let turns = 0;
    let executed = 0;
    let lastExecutedAt = 0;
    let started = 0;
    let lastStartedAt = 0;
    let settled = 0;
    let firstSettledAt = 0;
    const orms: MikroORM[] = [];
    const transports: BullMQTransport[] = [];
    const engines: WorkflowEngine[] = [];
    for (let k = 0; k < pods; k += 1) {
      const orm = await MikroORM.init({
        clientUrl: mysqlUrl,
        entities: [...ENTITIES],
        allowGlobalContext: true,
        pool: { min: 0, max: pool },
      });
      orms.push(orm);
      const inner = new MikroOrmStateStore(orm);
      if (k === 0) await inner.ensureSchema();
      const store = new Proxy(inner, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const name = String(prop);
            calls.set(name, (calls.get(name) ?? 0) + 1);
            if (name === 'settleCheckpointsIfPending' || name === 'saveCheckpointsIfPending') {
              batches.push((args[0] as unknown[]).length);
            }
            if (name === 'saveCheckpointIfPending') batches.push(1);
            const at = Date.now();
            const out = value.apply(target, args);
            void Promise.resolve(out)
              .finally(() => busyMs.set(name, (busyMs.get(name) ?? 0) + Date.now() - at))
              .catch(() => undefined);
            return out;
          };
        },
      });
      const transport = new BullMQTransport({
        connection,
        prefix,
        ...(resultConcurrency !== undefined ? { resultConcurrency } : {}),
      });
      const worker = new BullMQTransport({ connection, prefix, concurrency: workerConcurrency });
      worker.handle(STEP, async (input: unknown) => {
        executed += 1;
        lastExecutedAt = Date.now();
        return (input as { i: number }).i;
      });
      transports.push(transport, worker);
      const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
      engine.register('harness-fan', '1', async (ctx) => {
        turns += 1;
        const inputs = Array.from({ length: fan }, (_, i) => ({ i }));
        const out = await ctx.all(processLine, inputs, concurrency ? { concurrency } : {});
        return out.length;
      });
      engine.subscribe((e) => {
        if (e.type === 'step.started') {
          started += 1;
          lastStartedAt = Date.now();
        }
        if (e.type === 'step.completed') {
          settled += 1;
          if (!firstSettledAt) firstSettledAt = Date.now();
        }
      });
      engines.push(engine);
    }
    const probe = new MikroOrmStateStore(orms[0] as MikroORM);
    const t0 = Date.now();
    await (engines[0] as WorkflowEngine).start('harness-fan', {}, 'p');
    let lastLog = t0;
    for (;;) {
      const run = await probe.getRun('p');
      if (run?.status === 'completed' || run?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 250));
      if (Date.now() - lastLog >= 5_000) {
        lastLog = Date.now();
        console.log(
          `t=${Math.round((lastLog - t0) / 1000)}s dispatched=${started} executed=${executed} applied=${settled}`,
        );
      }
    }
    const done = Date.now();
    const s = (ms: number) => Math.round(ms / 100) / 10;
    const sum = batches.reduce((a, b) => a + b, 0);
    console.log(
      'HARNESS',
      JSON.stringify({
        fan,
        pods,
        workerConcurrency,
        pool,
        concurrency,
        resultConcurrency,
        totalS: s(done - t0),
        dispatchedAtS: s(lastStartedAt - t0),
        executedAtS: s(lastExecutedAt - t0),
        appliedAtS: s(done - t0),
        applyAfterFirstS: s(done - firstSettledAt),
        resultsPerSec: Math.round((fan / (done - firstSettledAt)) * 1000),
        turns,
        batches: batches.length,
        meanBatch: Math.round((sum / Math.max(1, batches.length)) * 10) / 10,
        barrierReads: calls.get('countCheckpoints') ?? 0,
        calls: Object.fromEntries(calls),
        busyMs: Object.fromEntries(busyMs),
      }),
    );
    await Promise.all(transports.map((t) => t.close()));
    await Promise.all(orms.map((o) => o.close(true)));
  }, 3_600_000);
});
