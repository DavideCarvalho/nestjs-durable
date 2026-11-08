import { writeFileSync } from 'node:fs';
// Micro-benchmark for the DISPATCHED `ctx.step` path: one engine process, the Drizzle Postgres store,
// and an in-process transport that runs each step on the next macrotask (like the EventEmitter
// transport). It reports, per scenario: SQL statements per step, ms per step (with the first and last
// decile for long runs), throughput, and the engine process's CPU per workflow.
//
//   docker run -d --name durperf-pg -p 127.0.0.1:55901:5432 -e POSTGRES_PASSWORD=p \
//     -e POSTGRES_DB=bench postgres:16
//   pnpm --filter @dudousxd/nestjs-durable-core build && pnpm --filter @dudousxd/nestjs-durable-store-drizzle build
//   node bench/dispatched-steps/run.mjs [seq10|seq200|seq1000|throughput|all] [--json out.json]
//   node --cpu-prof --cpu-prof-dir=/tmp/prof bench/dispatched-steps/run.mjs throughput
//
// Env: DATABASE_URL (default postgres://postgres:p@127.0.0.1:55901/bench), BENCH_WF (throughput
// workflow count, default 1000), BENCH_STARTERS (concurrent starters, default 32), BENCH_POOL (pool
// size, default 20), BENCH_REPEAT (runs per scenario, median reported, default 3), plus any engine
// option as JSON in BENCH_ENGINE_OPTS (e.g. '{"stickyRuns":0}').
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// BENCH_ROOT: another checkout to measure (e.g. a worktree of the base commit, built), so two
// builds can be compared run by run under the same machine load (see ab.mjs).
const root = (
  process.env.BENCH_ROOT
    ? resolve(process.env.BENCH_ROOT)
    : fileURLToPath(new URL('../../', import.meta.url))
).replace(/\/?$/, '/');
const require = createRequire(`${root}packages/store-drizzle/package.json`);
const pg = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const core = await import(`${root}packages/core/dist/index.js`);
const { DrizzlePgStateStore } = await import(`${root}packages/store-drizzle/dist/pg/index.js`);
const { WorkflowEngine } = core;
const DURABLE_STEP_NAME = Symbol.for('durable.step.name');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:p@127.0.0.1:55901/bench';
const WF = Number(process.env.BENCH_WF ?? 1000);
const STARTERS = Number(process.env.BENCH_STARTERS ?? 32);
const POOL = Number(process.env.BENCH_POOL ?? 20);
const REPEAT = Number(process.env.BENCH_REPEAT ?? 3);
const ENGINE_OPTS = JSON.parse(process.env.BENCH_ENGINE_OPTS ?? '{}');

// --- SQL statement counter: every query that reaches a pg client. -------------------------------
// With BENCH_SQL_LOG=1, also tally statements by their leading text and print the tally per scenario.
let statements = 0;
const tally = new Map();
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  statements += 1;
  if (process.env.BENCH_SQL_LOG) {
    const text = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '?');
    const key = text
      .replace(/\s+/g, ' ')
      .replace(/\$\d+/g, '?')
      .replace(/^select .*? from/, 'select … from')
      .slice(0, 150);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return origQuery.apply(this, args);
};
const printTally = (per) => {
  if (!process.env.BENCH_SQL_LOG) return;
  for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${(v / per).toFixed(2).padStart(6)}  ${k}`);
  }
  tally.clear();
};

// --- An in-process transport: a step runs on the next macrotask and its result is delivered back. ---
class InlineTransport {
  handlers = new Map();
  onResultHandler;
  async dispatch(task) {
    setImmediate(async () => {
      const fn = this.handlers.get(task.name);
      const startedAt = new Date().toISOString();
      let result;
      try {
        const output = await fn(task.input);
        result = {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'completed',
          output,
          startedAt,
        };
      } catch (err) {
        result = {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'failed',
          error: { message: String(err?.message ?? err) },
          startedAt,
        };
      }
      const deliver = (attempt) =>
        this.onResultHandler(result).catch((err) => {
          if (attempt > 20) return console.error('result lost', err);
          setTimeout(() => deliver(attempt + 1), 50);
        });
      deliver(0);
    });
  }
  onResult(handler) {
    this.onResultHandler = handler;
  }
  onHeartbeat() {}
}

const stepRef = (name) => {
  const fn = () => {};
  fn[DURABLE_STEP_NAME] = name;
  return fn;
};
const NOW = stepRef('bench.now');
const TICK = [1, 2, 3, 4, 5].map((i) => stepRef(`bench.s${i}`));

async function freshDb() {
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await origQuery.call(
    admin,
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_stat_statements;',
  );
  await admin.end();
}

/**
 * Statements Postgres executed (pg_stat_statements, BEGIN/COMMIT included), so stores whose driver
 * this process can't see (Prisma's engine) are counted the same way as the others.
 */
async function serverStatements() {
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  const { rows } = await origQuery.call(
    admin,
    "SELECT coalesce(sum(calls), 0)::bigint AS n FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT ILIKE '%pg_stat_statements%'",
  );
  await admin.end();
  return Number(rows[0].n);
}

/** BENCH_STORE: drizzle (default) | typeorm | mikro | prisma, each with its own schema. */
async function makeStore() {
  const kind = process.env.BENCH_STORE ?? 'drizzle';
  if (kind === 'drizzle') {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: POOL });
    const store = new DrizzlePgStateStore(drizzle(pool));
    await store.ensureSchema();
    return { store, close: () => pool.end() };
  }
  if (kind === 'typeorm') {
    const req = createRequire(`${root}packages/store-typeorm/package.json`);
    const { DataSource } = req('typeorm');
    const { ENTITIES, TypeOrmStateStore } = await import(
      `${root}packages/store-typeorm/dist/index.js`
    );
    const ds = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [...ENTITIES],
      extra: { max: POOL },
    });
    await ds.initialize();
    const store = new TypeOrmStateStore(ds);
    await store.ensureSchema();
    return { store, close: () => ds.destroy() };
  }
  if (kind === 'mikro') {
    const req = createRequire(`${root}packages/store-mikro-orm/package.json`);
    const { MikroORM } = req('@mikro-orm/postgresql');
    const { ENTITIES, MikroOrmStateStore } = await import(
      `${root}packages/store-mikro-orm/dist/index.js`
    );
    const orm = await MikroORM.init({
      clientUrl: DATABASE_URL,
      entities: [...ENTITIES],
      pool: { min: 0, max: POOL },
    });
    const store = new MikroOrmStateStore(orm);
    await store.ensureSchema();
    return { store, close: () => orm.close() };
  }
  if (kind === 'prisma') {
    // The Postgres client the store's DB spec generates (generated/pg-client), and its schema pushed.
    const dir = `${fileURLToPath(new URL('../../', import.meta.url))}packages/store-prisma`;
    const { execFileSync } = await import('node:child_process');
    execFileSync(
      'npx',
      [
        'prisma',
        'db',
        'push',
        '--schema',
        'prisma/test.pg.prisma',
        '--skip-generate',
        '--accept-data-loss',
      ],
      {
        cwd: dir,
        env: { ...process.env, PRISMA_PG_URL: DATABASE_URL },
        stdio: 'ignore',
      },
    );
    const req = createRequire(`${dir}/package.json`);
    const { PrismaClient } = req(`${dir}/generated/pg-client/index.js`);
    const { PrismaStateStore } = await import(`${root}packages/store-prisma/dist/index.js`);
    const prisma = new PrismaClient({ datasourceUrl: `${DATABASE_URL}?connection_limit=${POOL}` });
    await prisma.$connect();
    return { store: new PrismaStateStore(prisma), close: () => prisma.$disconnect() };
  }
  throw new Error(`unknown BENCH_STORE ${kind}`);
}

async function boot() {
  await freshDb();
  const { store, close } = await makeStore();
  const pool = { end: close };
  // BENCH_NO_ROUND_TRIP_METHODS=1: hide the optional round-trip-saving store methods, so the engine
  // takes its read-then-write paths (to measure the sticky continuation on its own).
  if (process.env.BENCH_NO_ROUND_TRIP_METHODS) {
    for (const m of ['settleResultsIfPending', 'tryLockRunAndGet', 'insertCheckpointIfAbsent']) {
      Object.defineProperty(store, m, { value: undefined });
    }
  }
  const transport = new InlineTransport();
  transport.handlers.set('bench.now', async () => Date.now());
  for (let i = 1; i <= 5; i += 1) transport.handlers.set(`bench.s${i}`, async (k) => k + 1);
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 60_000, ...ENGINE_OPTS });
  const done = new Map();
  engine.subscribe((event) => {
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      done.get(event.runId)?.(event);
      done.delete(event.runId);
    }
  });
  const whenDone = (runId) => new Promise((resolve) => done.set(runId, resolve));
  engine.register('long', '1', async (ctx, { n }) => {
    const stamps = [];
    for (let i = 0; i < n; i += 1) stamps.push(await ctx.step(NOW, i));
    return stamps;
  });
  engine.register('five', '1', async (ctx, input) => {
    let last = 0;
    for (const s of TICK) last = await ctx.step(s, last);
    return { i: input.i, last };
  });
  return { engine, pool, store, whenDone };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const cpuMs = (u) => (u.user + u.system) / 1000;

async function seq(n) {
  const env = await boot();
  tally.clear();
  const id = `long-${n}-${Date.now()}`;
  const p = env.whenDone(id);
  const s0 = await serverStatements();
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  await env.engine.start('long', { n }, id);
  const ev = await p;
  const ms = performance.now() - t0;
  const cpu = cpuMs(process.cpuUsage(c0));
  const sql = (await serverStatements()) - s0;
  printTally(n);
  if (ev.type !== 'run.completed')
    throw new Error(`run ${id} ${ev.type} ${JSON.stringify(ev.error)}`);
  const stamps = ev.output;
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  const decile = Math.max(1, Math.floor(gaps.length / 10));
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  await env.engine.drain?.(2000).catch(() => undefined);
  await env.pool.end();
  return {
    msPerStep: ms / n,
    firstDecile: avg(gaps.slice(0, decile)),
    lastDecile: avg(gaps.slice(-decile)),
    sqlPerStep: sql / n,
    cpuMsPerStep: cpu / n,
    stickyHits: env.engine.sticky?.hits ?? 0,
  };
}

async function throughput() {
  const env = await boot();
  tally.clear();
  const ids = Array.from({ length: WF }, (_, i) => `five-${i}-${Date.now()}`);
  const waits = ids.map((id) => env.whenDone(id));
  const s0 = await serverStatements();
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: STARTERS }, async () => {
      while (next < ids.length) {
        const i = next++;
        await env.engine.start('five', { i }, ids[i]);
      }
    }),
  );
  const events = await Promise.all(waits);
  const ms = performance.now() - t0;
  const cpu = cpuMs(process.cpuUsage(c0));
  const failed = events.filter((e) => e.type !== 'run.completed').length;
  if (failed) throw new Error(`${failed} runs failed`);
  const sql = (await serverStatements()) - s0;
  printTally(WF * 5);
  await env.engine.drain?.(2000).catch(() => undefined);
  await env.pool.end();
  return {
    wfPerSec: (WF * 1000) / ms,
    sqlPerStep: sql / (WF * 5),
    cpuMsPerWf: cpu / WF,
    // The engine process's CPU over the run, in % of one core.
    cpuPct: (100 * cpu) / ms,
    stickyHits: env.engine.sticky?.hits ?? 0,
  };
}

const SCENARIOS = {
  seq10: () => seq(10),
  seq200: () => seq(200),
  seq1000: () => seq(1000),
  throughput,
};

const which = process.argv[2] ?? 'all';
const names = which === 'all' ? Object.keys(SCENARIOS) : which.split(',');
const out = {};
for (const name of names) {
  const runs = [];
  for (let r = 0; r < REPEAT; r += 1) runs.push(await SCENARIOS[name]());
  const keys = Object.keys(runs[0]);
  out[name] = Object.fromEntries(
    keys.map((k) => [k, Number(median(runs.map((x) => x[k])).toFixed(2))]),
  );
  console.log(name, JSON.stringify(out[name]));
}
const jsonAt = process.argv.indexOf('--json');
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2));
process.exit(0);
