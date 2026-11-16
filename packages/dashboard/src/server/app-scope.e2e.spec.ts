import 'reflect-metadata';
import {
  type EngineEvent,
  type GroupHealth,
  InMemoryStateStore,
  type RunFacetQuery,
  RunGateway,
  type RunQuery,
  STATE_STORE_CANONICAL,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { type ExecutionContext, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { appScopedGateway, narrowToApps } from './app-scope.js';
import { normalizeConsoleResult } from './console-authorize.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';

const at = new Date('2026-01-01T00:00:00Z');
const run = (id: string, namespace: string | undefined, status = 'failed'): WorkflowRun =>
  ({
    id,
    workflow: 'wf',
    version: '1',
    status,
    input: {},
    namespace,
    createdAt: at,
    updatedAt: at,
  }) as unknown as WorkflowRun;

/** A store-backed-like gateway over a fixed set of runs, recording the actions it receives. */
function fakeGateway(runs: WorkflowRun[]) {
  const acted: string[] = [];
  const subscribed: string[] = [];
  const matches = (r: WorkflowRun, q: Pick<RunQuery, 'namespace' | 'namespaces' | 'status'>) =>
    (q.namespace === undefined || r.namespace === q.namespace) &&
    (q.namespaces === undefined || q.namespaces.includes(r.namespace as string)) &&
    (q.status === undefined || r.status === q.status);
  const byId = (id: string) => runs.find((r) => r.id === id) ?? null;
  const gateway = {
    topology: () => ({ role: 'control-plane' }),
    getRun: async (id: string) => byId(id),
    getRunDetail: async (id: string) => {
      const r = byId(id);
      return r ? { run: r, timeline: [], children: [] } : null;
    },
    listRuns: async (q: RunQuery) => runs.filter((r) => matches(r, q)),
    runFacets: async (q: RunFacetQuery) => {
      const counts = new Map<string, number>();
      for (const r of runs.filter((x) => matches(x, q))) {
        counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
      }
      return [...counts].map(([status, count]) => ({ status, origin: null, count }));
    },
    runValueFacets: async () => [],
    waitingFor: async () => ({}),
    workerHealth: async (): Promise<GroupHealth[]> =>
      [
        { group: 'charge@acme', depth: 0, liveWorkers: [] },
        { group: 'charge@beta', depth: 0, liveWorkers: [] },
        { group: 'charge', depth: 0, liveWorkers: [] },
      ] as unknown as GroupHealth[],
    retry: async (id: string) => {
      acted.push(`retry:${id}`);
      return { runId: id, status: 'running' };
    },
    cancel: async (id: string) => {
      acted.push(`cancel:${id}`);
      return { runId: id, status: 'cancelled' };
    },
    continue: async () => null,
    redispatchPending: async () => null,
    retryWithInput: async () => null,
    subscribe: (id: string, _onEvent: (e: EngineEvent) => void) => {
      subscribed.push(id);
      return () => {};
    },
  } as unknown as RunGateway;
  return { gateway, acted, subscribed };
}

const RUNS = [run('a1', 'acme'), run('a2', 'acme'), run('b1', 'beta'), run('own', undefined)];

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A control plane console whose `authorize` grants the apps named in `x-apps` (`*` for all). */
async function boot() {
  const { gateway, acted, subscribed } = fakeGateway(RUNS);
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });

  @Global()
  @Module({
    providers: [
      { provide: RunGateway, useValue: gateway },
      { provide: STATE_STORE_CANONICAL, useValue: store },
      { provide: WorkflowEngine, useValue: engine },
    ],
    exports: [RunGateway, STATE_STORE_CANONICAL, WorkflowEngine],
  })
  class HostDurableModule {}

  const dashboard = DurableDashboardModule.forRoot({
    authorize: (ctx: ExecutionContext) => {
      const header = ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers[
        'x-apps'
      ];
      if (header === undefined) return true;
      return { allowed: true, apps: header === '*' ? '*' : header.split(',') };
    },
  });

  @Module({ imports: [HostDurableModule, dashboard] })
  class HostRootModule {}

  app = await NestFactory.create<NestExpressApplication>(HostRootModule, {
    logger: false,
    abortOnError: false,
  });
  await app.init();
  return { server: app.getHttpServer(), acted, subscribed };
}

const ids = (body: { data: Array<{ id: string }> }) => body.data.map((r) => r.id).sort();

describe('console apps grant over HTTP', () => {
  it('confines the run list and its total to the granted apps', async () => {
    const { server } = await boot();

    const all = await request(server).get('/durable/api/runs');
    expect(ids(all.body)).toEqual(['a1', 'a2', 'b1', 'own']);
    expect(all.body.meta.total).toBe(4);

    const star = await request(server).get('/durable/api/runs').set('x-apps', '*');
    expect(ids(star.body)).toEqual(['a1', 'a2', 'b1', 'own']);

    const acme = await request(server).get('/durable/api/runs').set('x-apps', 'acme');
    expect(ids(acme.body)).toEqual(['a1', 'a2']);
    expect(acme.body.meta.total).toBe(2);

    // A namespace filter outside the grant matches nothing rather than widening it.
    const beta = await request(server)
      .get('/durable/api/runs?filter[namespace]=beta')
      .set('x-apps', 'acme');
    expect(ids(beta.body)).toEqual([]);
  });

  it('confines the facet counts', async () => {
    const { server } = await boot();
    const res = await request(server).get('/durable/api/runs/facets').set('x-apps', 'acme');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ status: 'failed', origin: null, count: 2 }]);
  });

  it("answers 404 for another app's run and refuses actions on it", async () => {
    const { server, acted } = await boot();
    expect((await request(server).get('/durable/api/runs/a1').set('x-apps', 'acme')).status).toBe(
      200,
    );
    expect((await request(server).get('/durable/api/runs/b1').set('x-apps', 'acme')).status).toBe(
      404,
    );
    expect((await request(server).get('/durable/api/runs/own').set('x-apps', 'acme')).status).toBe(
      404,
    );
    const cancel = await request(server).post('/durable/api/runs/b1/cancel').set('x-apps', 'acme');
    expect(cancel.status).toBe(404);
    await request(server).post('/durable/api/runs/b1/retry').set('x-apps', 'acme');
    await request(server).post('/durable/api/runs/a1/retry').set('x-apps', 'acme');
    expect(acted).toEqual(['retry:a1']);
  });

  it('bulk actions reach only the granted apps', async () => {
    const { server, acted } = await boot();
    const res = await request(server).post('/durable/api/bulk/retry').set('x-apps', 'acme');
    expect(res.body).toEqual({ matched: 2, applied: 2 });
    expect(acted.sort()).toEqual(['retry:a1', 'retry:a2']);
  });

  it("keeps only the granted apps' worker groups and refuses the process-wide metrics", async () => {
    const { server } = await boot();
    const workers = await request(server).get('/durable/api/workers').set('x-apps', 'acme');
    expect(workers.body.data.map((g: { group: string }) => g.group)).toEqual(['charge@acme']);
    const all = await request(server).get('/durable/api/workers');
    expect(all.body.data).toHaveLength(3);

    expect((await request(server).get('/durable/api/metrics').set('x-apps', 'acme')).status).toBe(
      403,
    );
    expect((await request(server).get('/durable/api/metrics')).status).toBe(200);
  });

  it("does not tail another app's run", async () => {
    const { server, subscribed } = await boot();
    const res = await request(server).get('/durable/api/runs/b1/stream').set('x-apps', 'acme');
    expect(res.text).not.toContain('data:');
    expect(subscribed).toEqual([]);
  });
});

describe('app scope units', () => {
  it('normalizes the apps grant', () => {
    expect(normalizeConsoleResult({ allowed: true, apps: '*' })).toEqual({
      allowed: true,
      apps: '*',
    });
    expect(normalizeConsoleResult({ allowed: true, apps: ['acme', '', 3] })).toEqual({
      allowed: true,
      apps: ['acme'],
    });
    expect(normalizeConsoleResult({ allowed: true })).toEqual({ allowed: true });
  });

  it('narrows a query to the apps, intersecting its own namespace filter', () => {
    expect(narrowToApps({}, ['acme', 'beta'])).toEqual({ namespaces: ['acme', 'beta'] });
    expect(narrowToApps({ namespace: 'acme' }, ['acme', 'beta'])).toEqual({
      namespaces: ['acme'],
    });
    expect(narrowToApps({ namespace: 'gamma' }, ['acme'])).toEqual({ namespaces: [] });
    expect(narrowToApps({ namespaces: ['beta', 'gamma'] }, ['acme', 'beta'])).toEqual({
      namespaces: ['beta'],
    });
  });

  it('the scoped gateway hides runs outside the apps', async () => {
    const { gateway } = fakeGateway(RUNS);
    const scoped = appScopedGateway(gateway, ['beta']);
    expect(await scoped.getRun?.('a1')).toBeNull();
    expect((await scoped.getRun?.('b1'))?.id).toBe('b1');
    expect(await scoped.retry('a1')).toBeNull();
    expect((await scoped.listRuns({})).map((r) => r.id)).toEqual(['b1']);
  });
});
