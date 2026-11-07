// Several engine processes sharing BullMQ, with separate step-worker processes: the topology where a
// step's result can land on any engine. Reports wf/s, SQL statements per step (engines), ms/step on a
// long run, and the sticky hit rate (turns that continued a parked body / step results).
//
//   docker run -d --name durperf-redis -p 127.0.0.1:56901:6379 redis:7-alpine
//   node bench/dispatched-steps/bull.mjs <engines=2> [workers=4] [scenario=throughput|seq200]
// Env: DATABASE_URL, REDIS_URL (default redis://127.0.0.1:56901), BENCH_ROOT, BENCH_WF (1000),
// BENCH_POOL (per engine, default 10), BENCH_STEP_CONCURRENCY (per worker, default 16).
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = (
  process.env.BENCH_ROOT
    ? resolve(process.env.BENCH_ROOT)
    : fileURLToPath(new URL('../../', import.meta.url))
).replace(/\/?$/, '/');
const requireStore = createRequire(`${root}packages/store-drizzle/package.json`);
const requireBull = createRequire(`${root}packages/transport-bullmq/package.json`);
const pg = requireStore('pg');
const { drizzle } = requireStore('drizzle-orm/node-postgres');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:p@127.0.0.1:55901/bench';
const REDIS_URL = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:56901');
const connection = {
  host: REDIS_URL.hostname,
  port: Number(REDIS_URL.port),
  maxRetriesPerRequest: null,
};
const WF = Number(process.env.BENCH_WF ?? 1000);
const POOL = Number(process.env.BENCH_POOL ?? 10);
const STEP_CONCURRENCY = Number(process.env.BENCH_STEP_CONCURRENCY ?? 16);
const PREFIX = 'durperf';

let statements = 0;
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  statements += 1;
  return origQuery.apply(this, args);
};

const STEPS = ['bench.s1', 'bench.s2', 'bench.s3', 'bench.s4', 'bench.s5', 'bench.now'];
const ref = (name) => Object.assign(() => {}, { [Symbol.for('durable.step.name')]: name });

async function transport(opts = {}) {
  const { BullMQTransport } = await import(`${root}packages/transport-bullmq/dist/index.js`);
  return new BullMQTransport({ connection, prefix: PREFIX, ...opts });
}

const role = process.argv[2];
if (role === '--worker') {
  const t = await transport({ concurrency: STEP_CONCURRENCY });
  for (const name of STEPS) {
    t.handle(name, async (input) => (name === 'bench.now' ? Date.now() : input + 1));
  }
  process.send('ready');
  process.on('message', async (m) => {
    if (m === 'stop') {
      await t.close();
      process.exit(0);
    }
  });
} else if (role === '--engine') {
  const core = await import(`${root}packages/core/dist/index.js`);
  const { DrizzlePgStateStore } = await import(`${root}packages/store-drizzle/dist/pg/index.js`);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: POOL });
  const store = new DrizzlePgStateStore(drizzle(pool));
  const t = await transport();
  const engine = new core.WorkflowEngine({ store, transport: t, reconcileMs: 60_000 });
  const S = [1, 2, 3, 4, 5].map((i) => ref(`bench.s${i}`));
  const NOW = ref('bench.now');
  engine.register('five', '1', async (ctx, input) => {
    let last = 0;
    for (const s of S) last = await ctx.step(s, last);
    return { i: input.i, last };
  });
  engine.register('long', '1', async (ctx, { n }) => {
    const stamps = [];
    for (let i = 0; i < n; i += 1) stamps.push(await ctx.step(NOW, i));
    return stamps;
  });
  engine.consumeRuns();
  process.send('ready');
  let c0;
  process.on('message', async (m) => {
    if (m.go) {
      statements = 0;
      c0 = process.cpuUsage();
      let next = 0;
      const ids = m.go.ids;
      await Promise.all(
        Array.from({ length: m.go.starters }, async () => {
          while (next < ids.length) {
            const i = next++;
            await engine.start(m.go.workflow, m.go.inputs[i], ids[i]);
          }
        }).map((p) => p.catch((e) => console.error(e))),
      );
    } else if (m === 'stop') {
      const u = process.cpuUsage(c0);
      process.send({
        statements,
        hits: engine.sticky?.hits ?? 0,
        misses: engine.sticky?.misses ?? 0,
        cpuMs: (u.user + u.system) / 1000,
      });
      await t.close();
      await pool.end();
      process.exit(0);
    }
  });
} else {
  const engines = Number(process.argv[2] ?? 2);
  const workers = Number(process.argv[3] ?? 4);
  const scenario = process.argv[4] ?? 'throughput';
  const { Redis } = requireBull('ioredis');
  const redis = new Redis(connection);
  await redis.flushall();
  redis.disconnect();
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await origQuery.call(admin, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  {
    const { DrizzlePgStateStore } = await import(`${root}packages/store-drizzle/dist/pg/index.js`);
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    await new DrizzlePgStateStore(drizzle(pool)).ensureSchema();
    await pool.end();
  }
  const spawn = async (r) => {
    const child = fork(fileURLToPath(import.meta.url), [r], { env: process.env });
    await new Promise((res) => child.once('message', res));
    return child;
  };
  const ws = await Promise.all(Array.from({ length: workers }, () => spawn('--worker')));
  const es = await Promise.all(Array.from({ length: engines }, () => spawn('--engine')));
  const t0 = performance.now();
  let ids;
  if (scenario === 'throughput') {
    ids = Array.from({ length: WF }, (_, i) => `five-${i}`);
    es.forEach((e, k) => {
      const mine = ids.filter((_, i) => i % engines === k);
      e.send({
        go: {
          workflow: 'five',
          ids: mine,
          inputs: mine.map((_, i) => ({ i })),
          starters: Math.ceil(32 / engines),
        },
      });
    });
  } else {
    ids = ['long-1'];
    es[0].send({ go: { workflow: 'long', ids, inputs: [{ n: 200 }], starters: 1 } });
  }
  for (;;) {
    const { rows } = await origQuery.call(
      admin,
      "SELECT count(*)::int AS n FROM durable_workflow_runs WHERE status = 'completed' AND workflow IN ('five', 'long')",
    );
    if (rows[0].n >= ids.length) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  const ms = performance.now() - t0;
  const reports = await Promise.all(
    es.map(
      (e) =>
        new Promise((res) => {
          e.once('message', res);
          e.send('stop');
        }),
    ),
  );
  for (const w of ws) w.send('stop');
  const steps = scenario === 'throughput' ? WF * 5 : 200;
  const sum = (k) => reports.reduce((a, r) => a + r[k], 0);
  const out = {
    sqlPerStep: Number((sum('statements') / steps).toFixed(2)),
    stickyHitPct: Number(((100 * sum('hits')) / steps).toFixed(1)),
    engineCpuMsPerStep: Number((sum('cpuMs') / steps).toFixed(2)),
  };
  if (scenario === 'throughput') out.wfPerSec = Number(((WF * 1000) / ms).toFixed(1));
  else {
    const { rows } = await origQuery.call(
      admin,
      "SELECT output FROM durable_workflow_runs WHERE id = 'long-1'",
    );
    const stamps = rows[0].output;
    out.msPerStep = Number(
      ((stamps[stamps.length - 1] - stamps[0]) / (stamps.length - 1)).toFixed(2),
    );
  }
  console.log(`bull e${engines} w${workers} ${scenario}`, JSON.stringify(out));
  await admin.end();
  process.exit(0);
}
