import 'reflect-metadata';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { DurableDashboardModule } from '@dudousxd/nestjs-durable-dashboard';
import { ENTITIES, TypeOrmStateStore } from '@dudousxd/nestjs-durable-store-typeorm';
import { DbTransport, typeOrmExecutor } from '@dudousxd/nestjs-durable-transport-db';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIAGNOSTICS_LISTENER_WORKFLOW, diagnosticsRunId } from './index';

/**
 * `transports.durable()` across real processes: one app process with diagnostics `role: 'api'`
 * emits, two with `role: 'worker'` run the deliveries. They share a real Postgres store and the DB
 * transport, as a split deployment would. Each listener call is appended to a log file the
 * processes share. Run with `pnpm test:db`.
 */

const CONTAINER_TIMEOUT = 180_000;
const externalPgUrl = process.env.DURABLE_TEST_PG_URL;
const skipped = !externalPgUrl && !!process.env.SKIP_TESTCONTAINERS;

const LAUNCHER = fileURLToPath(new URL('../../test/run-node.mjs', import.meta.url));
const NODE_ENTRY = fileURLToPath(new URL('../../test/diagnostics-node.ts', import.meta.url));
const VITE_CONFIG = fileURLToPath(new URL('../../../../vitest.db.config.ts', import.meta.url));
const LISTENER_ID = 'OrderListeners#onPlaced';

/** A database of this spec's own on a shared server, created when missing. */
async function dedicatedDatabase(baseUrl: string): Promise<DataSourceOptions> {
  const target = new URL(baseUrl);
  const name = `${decodeURIComponent(target.pathname.slice(1)) || 'postgres'}_diagnostics`;
  const admin = new DataSource({ type: 'postgres', url: baseUrl });
  await admin.initialize();
  try {
    const rows = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${name}"`).catch((err: { code?: string }) => {
        if (err.code !== '42P04' && err.code !== '23505') throw err;
      });
    }
  } finally {
    await admin.destroy();
  }
  target.pathname = `/${name}`;
  return { type: 'postgres', url: target.toString() };
}

let pgOptions: DataSourceOptions | undefined;
let pgError: unknown;
let pg: StartedPostgreSqlContainer | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    if (externalPgUrl) {
      pgOptions = await dedicatedDatabase(externalPgUrl);
      return;
    }
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    pgOptions = {
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
    };
  } catch (err) {
    pgError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await pg?.stop();
});

interface Node {
  role: 'api' | 'worker';
  child: ChildProcess;
  output: string[];
}

function startNode(role: Node['role'], env: Record<string, string>): Promise<Node> {
  const child = spawn(process.execPath, [LAUNCHER, VITE_CONFIG, NODE_ENTRY], {
    env: { ...process.env, ...env, DIAG_ROLE: role },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const node: Node = { role, child, output: [] };
  child.stdout?.on('data', (chunk) => node.output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => node.output.push(String(chunk)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${role} did not boot:\n${node.output.join('')}`)),
      90_000,
    );
    child.on('message', (message: { type?: string }) => {
      if (message.type !== 'ready') return;
      clearTimeout(timer);
      resolve(node);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`${role} exited with ${code} before it was ready:\n${node.output.join('')}`),
      );
    });
  });
}

async function stopNode(node: Node): Promise<void> {
  if (node.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => node.child.once('exit', () => resolve()));
  node.child.send({ type: 'exit' });
  const timer = setTimeout(() => node.child.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
}

interface Call {
  role: string;
  pid: number;
  eventId: string;
  nonce: string;
  outcome: 'ok' | 'throw';
}

function readCalls(workDir: string, nonce: string): Call[] {
  const file = join(workDir, 'calls.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [role, pid, eventId, lineNonce, outcome] = line.split(' ');
      return {
        role: role ?? '',
        pid: Number(pid),
        eventId: eventId ?? '',
        nonce: lineNonce ?? '',
        outcome: outcome as Call['outcome'],
      };
    })
    .filter((call) => call.nonce.startsWith(nonce));
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('transports.durable() across processes [real Postgres]', () => {
  it('emits on the api, runs each listener exactly once on a worker, retries a throw, and shows the run in the console', async (ctx) => {
    if (skipped || pgError || !pgOptions) {
      if (process.env.DURABLE_TEST_REQUIRE_BACKENDS) {
        throw new Error(`Postgres unavailable: ${String(pgError ?? 'SKIP_TESTCONTAINERS')}`);
      }
      ctx.skip();
      return;
    }
    const options = pgOptions;
    const workDir = mkdtempSync(join(tmpdir(), 'durable-diagnostics-'));
    const prefix = `diag_${randomUUID().slice(0, 8)}`;
    const nonce = randomUUID();

    // Schema first, once, so the three processes don't race to create it.
    const dataSource = new DataSource({ ...options, entities: [...ENTITIES] });
    await dataSource.initialize();
    const store = new TypeOrmStateStore(dataSource);
    await store.ensureSchema();

    // The console: an app on the same store that drives nothing, with the dashboard mounted.
    @Module({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new DbTransport({ executor: typeOrmExecutor(dataSource), prefix }),
          autoSchema: false,
          drive: false,
          consumers: false,
        }),
        DurableDashboardModule.forRoot(),
      ],
    })
    class ConsoleModule {}
    const consoleApp = await NestFactory.create<NestExpressApplication>(ConsoleModule, {
      logger: false,
    });
    await consoleApp.listen(0, '127.0.0.1');
    const consoleUrl = await consoleApp.getUrl();

    const env = {
      DIAG_WORK_DIR: workDir,
      DIAG_PG_OPTIONS: JSON.stringify(options),
      DIAG_TRANSPORT_PREFIX: prefix,
    };
    const nodes: Node[] = [];
    try {
      // One at a time: each boot transforms the workspace sources.
      nodes.push(await startNode('api', env));
      nodes.push(await startNode('worker', env));
      nodes.push(await startNode('worker', env));
      const [api] = nodes;

      api?.child.send({ type: 'emit', payload: { nonce: `${nonce}:plain` } });
      api?.child.send({ type: 'emit', payload: { nonce: `${nonce}:flaky`, failOnce: true } });

      await until(() => {
        const seen = readCalls(workDir, nonce);
        return seen.filter((c) => c.outcome === 'ok').length >= 2 ? seen : undefined;
      }, 'both listener calls');
      // Leave room for a duplicate to show up.
      await new Promise((r) => setTimeout(r, 1_500));
      const all = readCalls(workDir, nonce);

      expect(all.filter((c) => c.role === 'api')).toEqual([]);
      const ok = all.filter((c) => c.outcome === 'ok');
      expect(ok.map((c) => c.nonce).sort()).toEqual([`${nonce}:flaky`, `${nonce}:plain`]);
      const thrown = all.filter((c) => c.outcome === 'throw');
      expect(thrown.map((c) => c.nonce)).toEqual([`${nonce}:flaky`]);

      for (const call of ok) {
        const runId = diagnosticsRunId(call.eventId, LISTENER_ID);
        const stored = await store.getRun(runId);
        expect(stored).toMatchObject({
          workflow: DIAGNOSTICS_LISTENER_WORKFLOW,
          status: 'completed',
        });
        const [handle] = await store.listCheckpoints(runId);
        expect(handle).toMatchObject({
          name: 'handle',
          status: 'completed',
          attempts: call.nonce.endsWith(':flaky') ? 2 : 1,
        });

        const res = await fetch(`${consoleUrl}/durable/api/runs/${encodeURIComponent(runId)}`);
        expect(res.status).toBe(200);
        const body = JSON.stringify(await res.json());
        expect(body).toContain(JSON.stringify(runId));
        expect(body).toContain('"completed"');
      }
    } finally {
      for (const node of nodes) await stopNode(node);
      await consoleApp.close();
      await dataSource.destroy();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 240_000);
});
