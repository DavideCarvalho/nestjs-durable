// Run claiming across processes: N worker processes drive one backlog of pending runs by polling
// `runPending` (no run queue), as several replicas without a broker do. Reports workflows/s and SQL
// statements per workflow.
//
//   node bench/dispatched-steps/claim.mjs [workers=4] [runs=1000]
// Env: DATABASE_URL, BENCH_ROOT (the build to measure, as in run.mjs), BENCH_POOL (per process).
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = (
  process.env.BENCH_ROOT
    ? resolve(process.env.BENCH_ROOT)
    : fileURLToPath(new URL('../../', import.meta.url))
).replace(/\/?$/, '/');
const require = createRequire(`${root}packages/store-drizzle/package.json`);
const pg = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:p@127.0.0.1:55901/bench';
const POOL = Number(process.env.BENCH_POOL ?? 10);

let statements = 0;
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  statements += 1;
  return origQuery.apply(this, args);
};

async function engineFor(idle) {
  const core = await import(`${root}packages/core/dist/index.js`);
  const { DrizzlePgStateStore } = await import(`${root}packages/store-drizzle/dist/pg/index.js`);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: POOL });
  const store = new DrizzlePgStateStore(drizzle(pool));
  const engine = new core.WorkflowEngine({
    store,
    reconcileMs: 60_000,
    ...(idle ? { runDispatcher: { dispatch: () => undefined } } : {}),
  });
  engine.register('five', '1', async (ctx, input) => {
    let last = 0;
    for (let i = 1; i <= 5; i += 1) last = await ctx.localStep(`s${i}`, async () => last + i);
    return { i: input.i, last };
  });
  return { engine, store, pool };
}

if (process.argv[2] === '--worker') {
  const { engine, pool } = await engineFor(false);
  let stop = false;
  process.on('message', (m) => {
    if (m === 'stop') stop = true;
  });
  process.send('ready');
  await new Promise((resolve) => process.once('message', resolve)); // 'go'
  while (!stop) {
    const results = await engine.runPending();
    if (results.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await pool.end();
  process.send({ statements });
  process.exit(0);
} else {
  const workers = Number(process.argv[2] ?? 4);
  const runs = Number(process.argv[3] ?? 1000);
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await origQuery.call(admin, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const producer = await engineFor(true);
  await producer.store.ensureSchema();
  for (let i = 0; i < runs; i += 1) await producer.engine.start('five', { i }, `w${i}`);
  const children = await Promise.all(
    Array.from({ length: workers }, async () => {
      const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
        env: process.env,
        execArgv: process.execArgv,
      });
      await new Promise((resolve) => child.once('message', resolve));
      return child;
    }),
  );
  const t0 = performance.now();
  for (const c of children) c.send('go');
  for (;;) {
    const { rows } = await origQuery.call(
      admin,
      "SELECT count(*)::int AS n FROM durable_workflow_runs WHERE status = 'completed'",
    );
    if (rows[0].n >= runs) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const ms = performance.now() - t0;
  const counts = await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          c.once('message', (m) => resolve(m.statements));
          c.send('stop');
        }),
    ),
  );
  const sql = counts.reduce((a, b) => a + b, 0);
  console.log(
    `claim${workers}`,
    JSON.stringify({
      wfPerSec: Number(((runs * 1000) / ms).toFixed(1)),
      sqlPerWf: Number((sql / runs).toFixed(2)),
    }),
  );
  await admin.end();
  await producer.pool.end();
  process.exit(0);
}
