import {
  DURABLE_STEP_NAME,
  InMemoryTransport,
  type StepRef,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { DrizzlePgStateStore } from './drizzle-pg-state-store';

/**
 * Throughput harness, not a regression test: `H_RUNS` singleton runs over `H_KEYS` keys, or a wide
 * step fan with `H_FAN` steps, on `H_PODS` engine instances over real Postgres. Prints one
 * `HARNESS {...}` line: the seconds until every run settled and the store's deadlocks.
 *
 *   DURABLE_HARNESS=1 H_RUNS=60 H_KEYS=1 pnpm test:db packages/store-drizzle/src/pg/singleton-throughput
 */

const enabled = process.env.DURABLE_HARNESS === '1';
const runs = Number(process.env.H_RUNS ?? 60);
const keys = Number(process.env.H_KEYS ?? 1);
const fan = Number(process.env.H_FAN ?? 0);
const pods = Number(process.env.H_PODS ?? 4);
const repeat = Number(process.env.H_REPEAT ?? 1);

const STEP = 'harness-line';
const line = (() => {}) as unknown as StepRef<{ i: number }, number>;
(line as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = STEP;

let container: StartedPostgreSqlContainer | undefined;
let url = '';

beforeAll(async () => {
  if (!enabled) return;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  url = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

describe.runIf(enabled)('singleton throughput (harness)', () => {
  it('settles every run', async () => {
    for (let attempt = 0; attempt < repeat; attempt++) {
      const pools = Array.from(
        { length: pods },
        () => new pg.Pool({ connectionString: url, max: 10 }),
      );
      const stores = pools.map((pool) => new DrizzlePgStateStore(drizzle(pool)));
      await stores[0]?.ensureSchema();
      await pools[0]?.query('TRUNCATE durable_workflow_runs CASCADE');
      let deadlocks = 0;
      const engines = stores.map((store, i) => {
        const admit = store.tryAdmitSingleton.bind(store);
        store.tryAdmitSingleton = async (...args) => {
          try {
            return await admit(...args);
          } catch (err) {
            if ((err as { cause?: { code?: string } }).cause?.code === '40P01') deadlocks++;
            throw err;
          }
        };
        const transport = new InMemoryTransport();
        transport.handle(STEP, async ({ i: n }: { i: number }) => n);
        const engine = new WorkflowEngine({ store, transport, instanceId: `pod-${i}` });
        engine.register(
          'job',
          '1',
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return 'done';
          },
          { singleton: { key: (input: { key: string }) => input.key } },
        );
        engine.register('fan', '1', async (ctx) => {
          await ctx.all(
            line,
            Array.from({ length: fan }, (_, n) => ({ i: n })),
          );
          return 'done';
        });
        return engine;
      });
      const started = Date.now();
      let stop = false;
      const pollers = engines.map(async (engine) => {
        while (!stop) {
          // The module's TimerPoller: the same sweeps, in order, every second.
          await engine.runPending().catch(() => undefined);
          await engine.recoverIncomplete().catch(() => undefined);
          await engine.resumeDueTimers().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      });
      const total = fan > 0 ? 1 : runs;
      await Promise.all(
        Array.from({ length: total }, (_, n) => {
          const engine = engines[n % engines.length] as WorkflowEngine;
          return fan > 0
            ? engine.start('fan', {}, `f-${n}`)
            : engine.start('job', { key: `k${n % keys}` }, `r-${n}`);
        }),
      );
      const settled = async () => {
        const { rows } = await (pools[0] as pg.Pool).query(
          `SELECT count(*)::int AS n FROM durable_workflow_runs WHERE status = 'completed'`,
        );
        return rows[0].n as number;
      };
      const deadline = Date.now() + Number(process.env.H_DEADLINE_MS ?? 280_000);
      let done = await settled();
      while (done < total && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        done = await settled();
      }
      const seconds = (Date.now() - started) / 1000;
      if (done < total) {
        const { rows } = await (pools[0] as pg.Pool).query(
          `SELECT id, status, tags, locked_by, locked_until, wake_at FROM durable_workflow_runs WHERE status <> 'completed' LIMIT 5`,
        );
        console.log(`STUCK ${JSON.stringify(rows)}`);
      }
      stop = true;
      await Promise.all(pollers);
      console.log(
        `HARNESS ${JSON.stringify({ runs: total, keys, fan, pods, seconds, done, deadlocks })}`,
      );
      await Promise.allSettled(engines.map((engine) => engine.drain()));
      await Promise.allSettled(pools.map((pool) => pool.end()));
    }
  }, 590_000);
});
