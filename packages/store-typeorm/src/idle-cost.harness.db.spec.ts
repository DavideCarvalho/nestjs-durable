import { connect } from 'node:net';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { DataSource } from 'typeorm';
import { describe, it } from 'vitest';
// The poller by path: this package does not depend on the NestJS module, and the harness only needs it.
import type { DurableModuleOptions } from '../../nestjs/src/durable.module';
import { TimerPoller } from '../../nestjs/src/timer-poller';
import { durableEntities } from './entities';
import { LIFECYCLE_PENDING_INDEX } from './lifecycle-index';
import { TypeOrmStateStore } from './typeorm-state-store';

/** `INFO commandstats` over a bare socket (this package has no Redis client). */
function redisInfo(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host, () => socket.write('INFO commandstats\r\n'));
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const header = buf.indexOf('\r\n');
      if (header < 0) return;
      const size = Number(buf.slice(1, header));
      if (Buffer.byteLength(buf) >= header + 2 + size) {
        socket.end();
        resolve(buf.slice(header + 2, header + 2 + size));
      }
    });
    socket.on('error', reject);
  });
}

/**
 * Idle-cost harness, not a regression test: one driving instance (engine + timer poller) on TypeORM
 * over a real Postgres, and a worker transport serving `H_HANDLERS` step handlers over a real Redis,
 * with `H_RUNS` settled runs in the table and nothing to do. Prints one `IDLE {...}` line: Postgres
 * statements/s (pg_stat_statements), sequential scans and rows read by them on the runs table, and
 * Redis commands/s (INFO commandstats), over `H_SECONDS`.
 *
 * Opt-in, and skipped otherwise. Needs servers you start (Postgres with
 * `shared_preload_libraries=pg_stat_statements`):
 *
 *   IDLE_HARNESS=1 IDLE_PG_URL=postgres://... IDLE_REDIS_URL=redis://... \
 *     pnpm test:db packages/store-typeorm/src/idle-cost.harness.db.spec.ts
 *
 * Knobs: `H_RUNS` (100000), `H_HANDLERS` (50), `H_SECONDS` (60), `H_WARMUP_SECONDS` (10).
 * `H_LEGACY=1` measures the behavior before the idle-cost work on the same code: no owed-lifecycle
 * index, the owed listing and a fixed 1 s tick on every poll, BullMQ `drainDelay` 5 s.
 */

const enabled = process.env.IDLE_HARNESS === '1';
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
};
const runs = num('H_RUNS', 100_000);
const handlers = num('H_HANDLERS', 50);
const seconds = num('H_SECONDS', 60);
const warmup = num('H_WARMUP_SECONDS', 10);
const legacy = process.env.H_LEGACY === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(enabled)('idle cost (harness)', () => {
  it(`idle with ${runs} settled runs and ${handlers} handlers`, async () => {
    const pgUrl = process.env.IDLE_PG_URL as string;
    const redisUrl = new URL(process.env.IDLE_REDIS_URL as string);
    const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };
    const dataSource = new DataSource({
      type: 'postgres',
      url: pgUrl,
      entities: durableEntities(),
    });
    await dataSource.initialize();
    const store = new TypeOrmStateStore(dataSource);
    await store.ensureSchema();
    const [{ n }] = await dataSource.query('select count(*)::int as n from durable_workflow_runs');
    if (n < runs) {
      await dataSource.query(
        `insert into durable_workflow_runs (id, workflow, workflow_version, status, namespace, input, output, tags, created_at, updated_at)
         select 'seed-' || g, 'wf-' || (g % 20), '1', 'completed', 'default', '{}', '1', '["batch:' || (g % 50) || '"]',
                now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval
         from generate_series(${n + 1}, ${runs}) g`,
      );
      await dataSource.query('analyze durable_workflow_runs');
    }
    if (legacy) await dataSource.query(`drop index if exists ${LIFECYCLE_PENDING_INDEX}`);
    const prefix = `idle${Date.now()}`;
    const timing = legacy ? { drainDelay: 5 } : {};
    const transport = new BullMQTransport({ connection, prefix, ...timing });
    const worker = new BullMQTransport({ connection, prefix, ...timing });
    for (let i = 0; i < handlers; i += 1) worker.handle(`handler-${i}`, async () => 1);
    // As the NestJS module wires it: the transport is the control plane too.
    const engine = new WorkflowEngine({ store, transport, controlPlane: transport });
    engine.register('noop', '1', async () => 1);
    const options = {
      store,
      timerPollMs: 1_000,
      ...(legacy ? { maxIdleIntervalMs: 1_000, owedLifecycleSweepMs: 0 } : {}),
    } as unknown as DurableModuleOptions;
    const poller = new TimerPoller(engine, options);
    await poller.onApplicationBootstrap();
    await sleep(warmup * 1_000);

    const commandstats = async (): Promise<Map<string, number>> => {
      const info = await redisInfo(connection.host, connection.port);
      const out = new Map<string, number>();
      for (const line of info.split('\n')) {
        const m = line.match(/^cmdstat_([^:]+):calls=(\d+)/);
        if (m) out.set(m[1] as string, Number(m[2]));
      }
      return out;
    };
    const tableStats = async () =>
      (
        await dataSource.query(
          `select seq_scan::bigint as seq_scan, seq_tup_read::bigint as seq_tup_read, coalesce(idx_scan,0)::bigint as idx_scan, coalesce(idx_tup_fetch,0)::bigint as idx_tup_fetch
           from pg_stat_user_tables where relname = 'durable_workflow_runs'`,
        )
      )[0] as Record<string, string>;
    await dataSource.query('create extension if not exists pg_stat_statements');
    await dataSource.query('select pg_stat_statements_reset()');
    const t0 = await tableStats();
    const r0 = await commandstats();
    await sleep(seconds * 1_000);
    const t1 = await tableStats();
    const r1 = await commandstats();
    const statements = (await dataSource.query(
      `select calls::bigint as calls, rows::bigint as rows, query from pg_stat_statements
       where query not ilike '%pg_stat%' and query not ilike '%commandstats%' order by calls desc`,
    )) as Array<{ calls: string; rows: string; query: string }>;
    const pgCalls = statements.reduce((a, s) => a + Number(s.calls), 0);
    const redisDelta: Record<string, number> = {};
    let redisTotal = 0;
    for (const [cmd, calls] of r1) {
      const d = calls - (r0.get(cmd) ?? 0);
      if (d > 0 && cmd !== 'info') {
        redisDelta[cmd] = d;
        redisTotal += d;
      }
    }
    const per = (v: number) => Math.round((v / seconds) * 100) / 100;
    const delta = (k: string) => Number(t1[k]) - Number(t0[k]);
    console.log(
      'IDLE',
      JSON.stringify({
        legacy,
        runs,
        handlers,
        seconds,
        pgStatementsPerSec: per(pgCalls),
        runsSeqScansPerSec: per(delta('seq_scan')),
        runsSeqTupReadPerSec: per(delta('seq_tup_read')),
        runsIdxScansPerSec: per(delta('idx_scan')),
        redisCommandsPerSec: per(redisTotal),
        redis: redisDelta,
        topStatements: statements.slice(0, 12).map((s) => ({
          perSec: per(Number(s.calls)),
          query: s.query.replace(/\s+/g, ' ').slice(0, 160),
        })),
      }),
    );
    await poller.onModuleDestroy();
    await Promise.all([transport.close(), worker.close()]);
    await dataSource.destroy();
  }, 3_600_000);
});
