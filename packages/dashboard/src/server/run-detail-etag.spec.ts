import 'reflect-metadata';
import {
  type FanPageQuery,
  InMemoryStateStore,
  type RunDetailOptions,
  RunGateway,
  type StepCheckpoint,
  etagMatches,
  fanPageEtag,
  pageFanFromStore,
  runDetailEtag,
  summarizeRunFromStore,
} from '@dudousxd/nestjs-durable-core';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { RUN_GATEWAY } from './tokens.js';

const at = new Date('2026-06-11T00:00:00.000Z');

function step(seq: number, over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq,
    name: 'Lines.process',
    kind: 'remote',
    stepId: `r1:${seq}`,
    status: 'completed',
    output: seq,
    attempts: 1,
    parallelGroup: 'steps:0:100',
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
    ...over,
  };
}

/**
 * The console's detail endpoints over a real HTTP server, with a gateway that versions a detail the
 * way the store-backed one does (from the run row and the checkpoint buckets), so what is under
 * test is the HTTP half: the ETag going out, If-None-Match coming back, and the 304.
 */
describe('run detail ETags over HTTP', () => {
  let app: NestExpressApplication;
  let store: InMemoryStateStore;
  const detailOptions: Array<RunDetailOptions | undefined> = [];
  let versioned = true;

  const gateway = {
    async getRunDetail(runId: string, options?: RunDetailOptions) {
      detailOptions.push(options);
      const run = await store.getRun(runId);
      if (!run) return null;
      const over = options?.summarizeFansOver ?? 50;
      const stats = await store.checkpointStats(runId);
      const etag = runDetailEtag(run, stats, over);
      if (versioned && etagMatches(options?.ifNoneMatch, etag)) {
        return { run, timeline: [], children: [], notModified: true as const, etag };
      }
      const summary = await summarizeRunFromStore(store, runId, over, stats);
      return { run, ...summary, ...(versioned && { etag }) };
    },
    async getFanMembers(runId: string, group: string, query: FanPageQuery) {
      const stats = await store.checkpointStats(runId, { group });
      const etag = fanPageEtag(group, stats, query);
      if (etagMatches(query.ifNoneMatch, etag)) {
        return { items: [], total: 0, notModified: true as const, etag };
      }
      return { ...(await pageFanFromStore(store, runId, group, query, stats)), etag };
    },
  } as unknown as RunGateway;

  beforeEach(async () => {
    store = new InMemoryStateStore();
    detailOptions.length = 0;
    versioned = true;
    await store.createRun({
      id: 'r1',
      workflow: 'lines',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      createdAt: at,
      updatedAt: at,
    });
    for (let seq = 0; seq < 80; seq++) await store.saveCheckpoint(step(seq));

    @Global()
    @Module({ providers: [{ provide: RUN_GATEWAY, useValue: gateway }], exports: [RUN_GATEWAY] })
    class HostGatewayModule {}

    @Module({ imports: [HostGatewayModule, DurableDashboardModule.forRoot()] })
    class HostRootModule {}

    app = await NestFactory.create<NestExpressApplication>(HostRootModule, {
      logger: false,
      abortOnError: false,
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('versions the detail, answers an unchanged poll with a bare 304, and moves on a write', async () => {
    const first = await request(app.getHttpServer()).get('/durable/api/runs/r1');
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"rd-[0-9a-f]+"$/);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    expect(first.body.fans).toHaveLength(1);
    expect(first.body).not.toHaveProperty('etag');
    expect(first.body).not.toHaveProperty('notModified');

    const again = await request(app.getHttpServer())
      .get('/durable/api/runs/r1')
      .set('If-None-Match', etag);
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe(etag);
    expect(again.text ?? '').toBe('');
    expect(detailOptions.at(-1)).toEqual({ summarizeFansOver: 50, ifNoneMatch: etag });

    await store.saveCheckpoint(step(80));
    const moved = await request(app.getHttpServer())
      .get('/durable/api/runs/r1')
      .set('If-None-Match', etag);
    expect(moved.status).toBe(200);
    expect(moved.headers.etag).not.toBe(etag);
    expect(moved.body.fans[0].size).toBe(81);
  });

  it('moves the ETag when a member settles in place, with no new row', async () => {
    await store.saveCheckpoint(step(80, { status: 'pending' }));
    const before = await request(app.getHttpServer()).get('/durable/api/runs/r1');
    await store.saveCheckpoint(step(80));
    const after = await request(app.getHttpServer())
      .get('/durable/api/runs/r1')
      .set('If-None-Match', before.headers.etag as string);
    expect(after.status).toBe(200);
    expect(after.body.fans[0].counts).toEqual({ completed: 81 });
  });

  it('moves the ETag when only the run changes', async () => {
    const before = await request(app.getHttpServer()).get('/durable/api/runs/r1');
    await store.updateRun('r1', { status: 'running', updatedAt: new Date(at.getTime() + 1) });
    const after = await request(app.getHttpServer())
      .get('/durable/api/runs/r1')
      .set('If-None-Match', before.headers.etag as string);
    expect(after.status).toBe(200);
    expect(after.body.run.status).toBe('running');
  });

  it('versions a fan page by its group and the page asked for', async () => {
    const path = `/durable/api/runs/r1/fans/${encodeURIComponent('steps:0:100')}?limit=10`;
    const first = await request(app.getHttpServer()).get(path);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(10);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"fp-[0-9a-f]+"$/);

    const again = await request(app.getHttpServer()).get(path).set('If-None-Match', etag);
    expect(again.status).toBe(304);

    const otherPage = await request(app.getHttpServer())
      .get(`${path}&offset=10`)
      .set('If-None-Match', etag);
    expect(otherPage.status).toBe(200);

    await store.saveCheckpoint(step(3, { status: 'failed', attempts: 2 }));
    const moved = await request(app.getHttpServer()).get(path).set('If-None-Match', etag);
    expect(moved.status).toBe(200);
    expect(moved.body.items[3].status).toBe('failed');
  });

  it('answers in full, without a 304, when the gateway cannot version the detail', async () => {
    versioned = false;
    const first = await request(app.getHttpServer()).get('/durable/api/runs/r1');
    expect(first.status).toBe(200);
    expect(first.headers.etag ?? '').not.toMatch(/rd-/);
    expect(first.body).not.toHaveProperty('notModified');
  });

  it('does not ask a full detail to be versioned', async () => {
    await request(app.getHttpServer())
      .get('/durable/api/runs/r1?full=true')
      .set('If-None-Match', '"x"');
    expect(detailOptions.at(-1)).toBeUndefined();
  });
});
