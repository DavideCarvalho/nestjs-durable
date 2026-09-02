import 'reflect-metadata';
import {
  type RunFacetQuery,
  RunGateway,
  type RunListItem,
  type RunQuery,
  type RunValueAxis,
} from '@dudousxd/nestjs-durable-core';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runQueryString } from '../client/run-query-string.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';
import { RUN_GATEWAY } from './tokens.js';

/**
 * The console over a REAL HTTP server, with the URL its own client builds.
 *
 * Everything else in this package tests one hop: the client makes a query string, or the controller
 * takes an already-parsed object. Both passed while the console shipped broken, because the step
 * between them — an HTTP layer parsing that query string — was never exercised. Express 5 changed
 * its default `query parser` to `simple`, which leaves `filter[where][0][field]` as a literal key,
 * and every predicate was dropped in silence: the list answered 200, unfiltered, and the value
 * pickers came back empty.
 *
 * So: the parser is left at its DEFAULT here on purpose. A host does not have to configure one.
 *
 * This file imports the CLIENT's query-string builder, which is why `tsconfig.server.json` declares
 * no `rootDir` — the hop being tested lives between the two halves of this package, so a test of it
 * has to reach across.
 */
describe('the console over HTTP', () => {
  let app: NestExpressApplication;
  const queries: RunQuery[] = [];
  const valueFacets: Array<{ axis: RunValueAxis; query: RunFacetQuery }> = [];

  const gateway = {
    async listRuns(query: RunQuery): Promise<RunListItem[]> {
      queries.push(query);
      return [];
    },
    async runValueFacets(axis: RunValueAxis, query: RunFacetQuery) {
      valueFacets.push({ axis, query });
      return [{ value: 'etl', count: 3 }];
    },
    async runFacets() {
      return [];
    },
  } as unknown as RunGateway;

  beforeEach(async () => {
    queries.length = 0;
    valueFacets.length = 0;

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

  it('carries the run list predicates the client encoded', async () => {
    const qs = runQueryString(
      { tag: ['etl', 'nightly'], namespace: 'acme', status: 'failed' },
      { limit: 100 },
    );

    const res = await request(app.getHttpServer()).get(`/durable/api/runs?${qs}`);

    expect(res.status).toBe(200);
    expect(queries[0]).toMatchObject({
      tags: ['etl', 'nightly'],
      namespace: 'acme',
      status: 'failed',
      limit: 100,
    });
  });

  it('narrows rather than answering with everything — the failure this guards', async () => {
    // The regression reads as success: unrecognised predicates leave the query unnarrowed, and the
    // route still answers 200. Asserting the QUERY the gateway received is what tells them apart.
    const qs = runQueryString({ namespace: 'acme' });

    await request(app.getHttpServer()).get(`/durable/api/runs?${qs}`);

    expect(queries[0]?.namespace).toBe('acme');
    expect(queries[0]).not.toEqual({});
  });

  it('answers a value picker, scoped by the other filters', async () => {
    const qs = runQueryString({ namespace: 'acme' }, {}, { field: 'tag', limit: 20 });

    const res = await request(app.getHttpServer()).get(`/durable/api/runs/values?${qs}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ value: 'etl', count: 3 }]);
    expect(valueFacets[0]?.axis).toEqual({ field: 'tag' });
    expect(valueFacets[0]?.query).toMatchObject({ namespace: 'acme' });
  });

  it('selects the unattributed bucket, which no origin value can match', async () => {
    const qs = runQueryString({ origin: null });

    await request(app.getHttpServer()).get(`/durable/api/runs?${qs}`);

    expect(queries[0]?.origin).toBeNull();
  });
});
