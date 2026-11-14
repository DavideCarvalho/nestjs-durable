import 'reflect-metadata';
import {
  type RunFacetQuery,
  type RunFacetRow,
  RunGateway,
  type RunListItem,
  type RunQuery,
  type RunValueAxis,
  type RunValueFacetRow,
  type RunWaiting,
} from '@dudousxd/nestjs-durable-core';
import { FilterRunner } from '@dudousxd/nestjs-filter';
import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import { RUN_QUERY_ADAPTER, RunQueryAdapter } from './run-query.adapter.js';
import { RunFilter } from './run.filter.js';

type Query = Record<string, unknown>;

interface Console {
  /** Request query → the whole path a real one takes: wire parsing, filter, adapter, controller. */
  list(query?: Query): Promise<Awaited<ReturnType<DurableApiController['runs']>>>;
  facets(query?: Query): Promise<RunFacetRow[]>;
  values(query: Query): Promise<unknown>;
  bulk(action: 'retry' | 'cancel', query?: Query): Promise<unknown>;
  controller: DurableApiController;
  queries: RunQuery[];
  facetQueries: RunFacetQuery[];
  valueFacets: Array<{ axis: RunValueAxis; query: RunFacetQuery; limit?: number }>;
}

/**
 * Controller → filter → adapter → service → gateway, wired for real (no store/engine — the tenant
 * shape), recording what the GATEWAY is asked for. Asserting on the query the gateway receives is
 * what makes these tests about a predicate surviving the whole trip: a request now travels through
 * `@dudousxd/nestjs-filter`'s parsing and this package's `RunQueryAdapter` before it becomes a
 * `RunQuery`, and either step could drop it.
 */
async function makeConsole(runs: RunListItem[] = []): Promise<Console> {
  const queries: RunQuery[] = [];
  const facetQueries: RunFacetQuery[] = [];
  const valueFacets: Array<{ axis: RunValueAxis; query: RunFacetQuery; limit?: number }> = [];
  const gateway: RunGateway = {
    async listRuns(query) {
      queries.push(query);
      return runs;
    },
    async runFacets(query): Promise<RunFacetRow[]> {
      facetQueries.push(query);
      return [
        { status: 'failed', origin: null, count: 3 },
        { status: 'completed', origin: '@acme/billing', count: 7 },
      ];
    },
    async runValueFacets(axis, query, opts): Promise<RunValueFacetRow[]> {
      valueFacets.push({ axis, query, ...(opts?.limit !== undefined && { limit: opts.limit }) });
      return [
        { value: 'etl', count: 4 },
        { value: 'nightly', count: 1 },
      ];
    },
    async waitingFor(): Promise<Record<string, RunWaiting>> {
      return {};
    },
    async workerHealth() {
      return [];
    },
    topology() {
      return { role: 'control-plane' };
    },
    async getRunDetail() {
      const run = runs[0];
      return run ? { run, timeline: [], children: [] } : null;
    },
    async retry() {
      return null;
    },
    async cancel() {
      return null;
    },
    async continue() {
      return null;
    },
    async redispatchPending() {
      return null;
    },
    async retryWithInput() {
      return null;
    },
    subscribe: () => () => {},
  };

  const adapter = new RunQueryAdapter(gateway);
  const filter = new RunFilter();
  // Only the two providers the run filter actually names. The GLOBAL filter adapter is `null` on
  // purpose: it stands for a host application whose own adapter is an ORM's, and it means every
  // query below reaches the gateway only through the token `RunFilter` declares.
  const moduleRef = {
    resolve: async (token: unknown) => {
      if (token === RunFilter) return filter;
      throw new Error('could not find');
    },
    get: (token: unknown) => {
      if (token === RunFilter) return filter;
      if (token === RUN_QUERY_ADAPTER) return adapter;
      if (token === FilterRunner) return runner;
      throw new Error('could not find');
    },
    // Typed off the constructor rather than off `ModuleRef` directly: the runner only ever calls
    // `resolve`/`get` on it, and naming the class would tie this stub to one copy of @nestjs/core.
  } as unknown as ConstructorParameters<typeof FilterRunner>[0];
  const runner = new FilterRunner(moduleRef, { validation: 'off' }, null);
  const controller = new DurableApiController(new DashboardService(gateway), runner);

  return {
    controller,
    queries,
    facetQueries,
    valueFacets,
    list(query = {}) {
      return controller.runs(query);
    },
    async facets(query = {}) {
      return (await controller.facets(query)).data;
    },
    values(query) {
      return controller.values(query);
    },
    bulk(action, query = {}) {
      return controller.bulk(action, query);
    },
  };
}

/** A run as the gateway hands it over, payloads and all — the shape the list endpoint must strip. */
function runWithPayloads(overrides: Partial<RunListItem> = {}): RunListItem {
  return {
    id: 'run-1',
    workflow: 'checkout',
    workflowVersion: '1',
    status: 'failed',
    namespace: 'default',
    input: { order: 'ord-1' },
    output: { charged: false },
    error: { message: 'boom', stack: 'Error: boom\n    at x' },
    tags: ['tier:pro'],
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:01:00.000Z'),
    ...overrides,
  } as RunListItem;
}

describe('DurableApiController: run-list filters', () => {
  it('narrows by namespace and origin when the operator asks', async () => {
    const c = await makeConsole();

    await c.list({ filter: { namespace: 'acme', origin: '@dudousxd/agent' } });

    expect(c.queries[0]?.namespace).toBe('acme');
    expect(c.queries[0]?.origin).toBe('@dudousxd/agent');
  });

  it('leaves BOTH undefined when no param is sent — the default is every tenant, every origin', async () => {
    // Core is explicit that read paths are not namespace-scoped. If this ever defaulted to a single
    // tenant, every existing operator would silently stop seeing the other tenants' runs.
    const c = await makeConsole();

    await c.list();

    expect(c.queries[0]?.namespace).toBeUndefined();
    expect(c.queries[0]?.origin).toBeUndefined();
  });

  it('treats a blank param as absent, not as a tenant named ""', async () => {
    // `filter[namespace]=` is what a cleared filter box sends. Passing '' through would be an exact
    // match against a namespace nothing has — a console that goes empty for no visible reason.
    const c = await makeConsole();

    await c.list({ filter: { namespace: '', origin: '' } });

    expect(c.queries[0]?.namespace).toBeUndefined();
    expect(c.queries[0]?.origin).toBeUndefined();
  });

  it('reads every predicate from the filter[...] wire', async () => {
    const c = await makeConsole();

    await c.list({
      filter: {
        status: 'dead',
        workflow: 'checkout',
        tag: 'tier:pro',
        'attr.amount': { gte: '200' },
        namespace: 'acme',
      },
    });

    expect(c.queries[0]).toMatchObject({
      status: 'dead',
      workflow: 'checkout',
      tag: 'tier:pro',
      namespace: 'acme',
    });
    expect(c.queries[0]?.attributes).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
  });

  it('reads the flat bracket keys a host without a nested query parser hands over', async () => {
    // Express 5's default query parser leaves `filter[status]` as a literal key.
    const c = await makeConsole();

    await c.list({ 'filter[status]': 'failed', 'filter[attr.tier][in]': 'pro,enterprise' });

    expect(c.queries[0]).toMatchObject({ status: 'failed' });
    expect(c.queries[0]?.attributes).toEqual([
      { key: 'tier', op: 'in', values: ['pro', 'enterprise'] },
    ]);
  });

  it('no longer reads the removed flat params', async () => {
    const c = await makeConsole();

    await c.list({ status: 'dead', limit: '5', offset: '10' });

    expect(c.queries[0]?.status).toBeUndefined();
    expect(c.queries[0]).toMatchObject({ limit: 100, offset: 0 });
  });
});

describe('DurableApiController: multi-value predicates', () => {
  it('ORs a tag list into `tags`, and keeps a single one as `tag`', async () => {
    const c = await makeConsole();

    await c.list({ filter: { tag: ['etl', 'nightly'] } });
    await c.list({ filter: { tag: 'etl' } });
    await c.list({ filter: { tag: 'etl,nightly' } });
    await c.list({ filter: { tag: { in: 'etl,nightly' } } });

    expect(c.queries[0]).toMatchObject({ tags: ['etl', 'nightly'] });
    expect(c.queries[0]?.tag).toBeUndefined();
    expect(c.queries[1]).toMatchObject({ tag: 'etl' });
    expect(c.queries[1]?.tags).toBeUndefined();
    expect(c.queries[2]).toMatchObject({ tags: ['etl', 'nightly'] });
    expect(c.queries[3]).toMatchObject({ tags: ['etl', 'nightly'] });
  });

  it('ORs several tenants into `namespaces`, so a few can be compared side by side', async () => {
    const c = await makeConsole();

    await c.list({ filter: { namespace: ['acme', 'globex'] } });

    expect(c.queries[0]).toMatchObject({ namespaces: ['acme', 'globex'] });
  });

  it('ORs several statuses into `statuses`, and keeps a single one as `status`', async () => {
    const c = await makeConsole();

    await c.list({ filter: { status: ['running', 'suspended'] } });
    await c.list({ filter: { status: 'dead' } });

    expect(c.queries[0]).toMatchObject({ statuses: ['running', 'suspended'] });
    expect(c.queries[0]?.status).toBeUndefined();
    expect(c.queries[1]).toMatchObject({ status: 'dead' });
    expect(c.queries[1]?.statuses).toBeUndefined();
  });

  it('carries a set of search-attribute values as one `in` predicate, not two ANDed equalities', async () => {
    // Two `eq` predicates on the same key are ANDed like every other pair, and no run has one
    // attribute with two values — the multi-select would always return nothing.
    const c = await makeConsole();

    await c.list({ filter: { 'attr.tier': { in: ['pro', 'enterprise'] } } });

    expect(c.queries[0]?.attributes).toEqual([
      { key: 'tier', op: 'in', values: ['pro', 'enterprise'] },
    ]);
  });

  it('coerces attribute operands, so a numeric set compares as numbers', async () => {
    const c = await makeConsole();

    await c.list({ filter: { 'attr.amount': { in: '200,300' } } });

    expect(c.queries[0]?.attributes).toEqual([{ key: 'amount', op: 'in', values: [200, 300] }]);
  });
});

describe('DurableApiController: requests this backend cannot serve', () => {
  it('refuses an unknown filter field instead of returning a wider set', async () => {
    const c = await makeConsole();

    await expect(c.list({ filter: { bogus: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
    expect(c.queries).toEqual([]);
  });

  it('refuses an unsupported operator', async () => {
    // Dropping the clause would answer with every run and look exactly like success.
    const c = await makeConsole();

    await expect(c.list({ filter: { tag: { contains: 'etl' } } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(c.list({ filter: { 'attr.tier': { contains: 'p' } } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(c.queries).toEqual([]);
  });

  it('refuses a sort it cannot honour rather than silently returning another order', async () => {
    // A paginated list served in an order the client did not ask for skips and duplicates rows.
    const c = await makeConsole();

    await expect(c.list({ sort: 'workflow' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.list({ sort: 'createdAt' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the one order a run listing actually has', async () => {
    const c = await makeConsole();

    await c.list({ sort: '-createdAt' });

    expect(c.queries).toHaveLength(1);
  });

  it('refuses a page param that is not a whole number of at least 1', async () => {
    const c = await makeConsole();

    await expect(c.list({ page: '0' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.list({ size: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DurableApiController: paging', () => {
  it('asks the store for one page and answers with the offset envelope', async () => {
    const c = await makeConsole([runWithPayloads()]);

    const page = await c.list({ page: '3', size: '20' });

    expect(c.queries[0]).toMatchObject({ limit: 20, offset: 40 });
    // The total is the facet aggregate (3 failed + 7 completed), not the length of the page.
    expect(page.meta).toEqual({
      total: 10,
      perPage: 20,
      currentPage: 3,
      lastPage: 1,
      firstPage: 1,
    });
  });

  it('bounds the page by default and clamps an oversized one', async () => {
    const c = await makeConsole();

    await c.list();
    await c.list({ size: '10000' });

    expect(c.queries[0]).toMatchObject({ limit: 100, offset: 0 });
    expect(c.queries[1]).toMatchObject({ limit: 500 });
  });

  it('counts only the statuses and origins the request selects', async () => {
    const c = await makeConsole();

    const page = await c.list({ filter: { status: 'failed' } });

    expect(page.meta.total).toBe(3);
  });
});

describe('DurableApiController: bulk scoping', () => {
  it('carries namespace and origin into the set a bulk action acts on', async () => {
    // A bulk retry/cancel that dropped these would act on runs from tenants and libraries the
    // operator never had on screen.
    const c = await makeConsole();

    await c.bulk('cancel', {
      filter: { status: 'dead', namespace: 'acme', origin: '@dudousxd/agent' },
      compensate: 'true',
    });

    expect(c.queries[0]).toMatchObject({
      status: 'dead',
      namespace: 'acme',
      origin: '@dudousxd/agent',
    });
  });

  it('treats blank bulk params as absent too', async () => {
    const c = await makeConsole();

    await c.bulk('retry', { filter: { namespace: '', origin: '' } });

    expect(c.queries[0]?.namespace).toBeUndefined();
    expect(c.queries[0]?.origin).toBeUndefined();
  });

  it('ignores page params, so "retry all" is not "retry the first page"', async () => {
    const c = await makeConsole();

    await c.bulk('retry', { filter: { status: 'dead' }, page: '3', size: '100' });

    expect(c.queries[0]?.offset).toBeUndefined();
    // `bulk` applies its own bound; what matters is that the operator's 100 is gone.
    expect(c.queries[0]?.limit).not.toBe(100);
  });
});

describe('DurableApiController: the unattributed bucket', () => {
  it('asks the store for runs with NO origin, which no origin VALUE can match', async () => {
    const c = await makeConsole();

    await c.list({ filter: { unattributed: 'true' } });

    expect(c.queries[0]?.origin).toBeNull();
  });

  it('refuses a value that is not a boolean', async () => {
    const c = await makeConsole();

    await expect(c.list({ filter: { unattributed: 'yes' } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('unions with a concurrent origin — "this package plus the runs nothing claims"', async () => {
    const c = await makeConsole();

    await c.list({ filter: { origin: '@dudousxd/agent', unattributed: 'true' } });

    expect(c.queries[0]?.origins).toEqual(['@dudousxd/agent', null]);
  });

  it('resolves the same way whichever order the two params arrive in', async () => {
    const c = await makeConsole();

    await c.list({ filter: { unattributed: 'true', origin: '@dudousxd/agent' } });

    expect(c.queries[0]?.origins).toEqual(['@dudousxd/agent', null]);
  });

  it('scopes a BULK action to it too — or retry-all would reach every origin', async () => {
    const c = await makeConsole();

    await c.bulk('cancel', { filter: { unattributed: 'true' } });

    expect(c.queries[0]?.origin).toBeNull();
  });
});

describe('DurableApiController: facets', () => {
  it('counts over the tag/tenant/attribute predicates the listing uses', async () => {
    const c = await makeConsole();

    await c.facets({
      filter: {
        workflow: 'checkout',
        tag: 'tier:pro',
        'attr.amount': { gte: '200' },
        namespace: 'acme',
      },
    });

    expect(c.facetQueries[0]).toMatchObject({
      workflow: 'checkout',
      tag: 'tier:pro',
      namespace: 'acme',
    });
    expect(c.facetQueries[0]?.attributes).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
  });

  it('is not narrowed by the axes it reports, even when the request carries them', async () => {
    // Counting "how many are failed" inside a query already filtered to failed answers itself.
    const c = await makeConsole();

    await c.facets({ filter: { status: 'failed', origin: '@acme/billing' }, size: '10' });

    expect(c.facetQueries[0]).not.toHaveProperty('status');
    expect(c.facetQueries[0]).not.toHaveProperty('origin');
    expect(c.facetQueries[0]).not.toHaveProperty('limit');
  });

  it('wraps the cells as { data }', async () => {
    const c = await makeConsole();

    const body = await c.controller.facets({});

    expect(body.data).toHaveLength(2);
  });
});

describe('DurableApiController: value pickers', () => {
  it('enumerates a field over the runs the OTHER filters select', async () => {
    // The whole point of scoping: pick a tenant, and the tag picker offers that tenant's tags.
    const c = await makeConsole();

    const rows = await c.values({
      filter: { namespace: 'acme' },
      groupByCount: { field: 'tag' },
    });

    expect(c.valueFacets[0]?.axis).toEqual({ field: 'tag' });
    expect(c.valueFacets[0]?.query).toMatchObject({ namespace: 'acme' });
    expect(rows).toEqual([
      { value: 'etl', count: 4 },
      { value: 'nightly', count: 1 },
    ]);
  });

  it('takes flat groupByCount keys next to flat filter keys', async () => {
    const c = await makeConsole();

    await c.values({ 'filter[namespace]': 'acme', 'groupByCount[field]': 'tag' });

    expect(c.valueFacets[0]?.axis).toEqual({ field: 'tag' });
    expect(c.valueFacets[0]?.query).toMatchObject({ namespace: 'acme' });
  });

  it('refuses an unknown filter field here too', async () => {
    const c = await makeConsole();

    await expect(
      c.values({ filter: { bogus: 'x' }, groupByCount: { field: 'tag' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bounds the answer, because tag cardinality grows with the data', async () => {
    const c = await makeConsole();

    await c.values({ groupByCount: { field: 'tag', limit: '20' } });

    expect(c.valueFacets[0]?.limit).toBe(20);
  });

  it('bounds it by default too — an unbounded picker is a listing', async () => {
    const c = await makeConsole();

    await c.values({ groupByCount: { field: 'tag' } });

    expect(c.valueFacets[0]?.limit).toBeGreaterThan(0);
  });

  it('lists the search-attribute KEYS in use, and the values under one key', async () => {
    const c = await makeConsole();

    await c.values({ groupByCount: { field: 'attr' } });
    await c.values({ groupByCount: { field: 'attr.tier' } });

    expect(c.valueFacets[0]?.axis).toEqual({ field: 'attributeKey' });
    expect(c.valueFacets[1]?.axis).toEqual({ field: 'attributeValue', key: 'tier' });
  });

  it('rejects a field it cannot enumerate rather than answering with an empty picker', async () => {
    // An empty dropdown and "this field has no values" are indistinguishable to an operator.
    const c = await makeConsole();

    await expect(c.values({ groupByCount: { field: 'id' } })).rejects.toThrow();
  });
});

describe('DurableApiController: list rows', () => {
  it('drops input, output and error — the payloads only the detail view renders', async () => {
    // Measured on a 9.5k-run control plane, `error` alone was 63% of a 12 MB listing while no list row
    // reads it.
    const c = await makeConsole([runWithPayloads()]);

    const { data } = await c.list();

    expect(data[0]).not.toHaveProperty('input');
    expect(data[0]).not.toHaveProperty('output');
    expect(data[0]).not.toHaveProperty('error');
  });

  it('keeps every field a row or its derived state reads', async () => {
    const c = await makeConsole([runWithPayloads()]);

    const { data } = await c.list();

    expect(data[0]).toMatchObject({
      id: 'run-1',
      workflow: 'checkout',
      status: 'failed',
      namespace: 'default',
      tags: ['tier:pro'],
    });
  });

  it('leaves the DETAIL endpoint whole — that is where the payloads are rendered', async () => {
    // The projection belongs to the list endpoint, not to the run. A run opened FROM that list must
    // still arrive with its input/output/error, or the fix would have traded a slow console for one
    // that cannot show a failure's stack.
    const c = await makeConsole([runWithPayloads()]);

    const detail = await c.controller.run('run-1');

    expect(detail.run.input).toEqual({ order: 'ord-1' });
    expect(detail.run.output).toEqual({ charged: false });
    expect(detail.run.error?.message).toBe('boom');
  });
});

describe('DurableApiController: schedules', () => {
  it('narrows by filter[...] and answers { data } bounded by size', async () => {
    const c = await makeConsole();
    const service = (c.controller as unknown as { dashboard: DashboardService }).dashboard;
    const seen: unknown[] = [];
    service.listSchedules = async (query) => {
      seen.push(query);
      return [];
    };

    const body = await c.controller.schedules({
      filter: { namespace: 'acme', paused: 'true' },
      size: '5000',
    });

    expect(body).toEqual({ data: [] });
    expect(seen[0]).toEqual({ namespace: 'acme', paused: true, limit: 1000 });
  });

  it('refuses an unknown filter field and a non-boolean paused', async () => {
    const c = await makeConsole();

    await expect(c.controller.schedules({ filter: { status: 'x' } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(c.controller.schedules({ filter: { paused: 'maybe' } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('DurableApiController: fan members', () => {
  it('pages with page/size and filter[failed], as an offset page', async () => {
    const c = await makeConsole();
    const service = (c.controller as unknown as { dashboard: DashboardService }).dashboard;
    const seen: unknown[] = [];
    service.getFanMembers = async (_id, _group, query) => {
      seen.push(query);
      return { items: [], total: 1200 };
    };

    const body = await c.controller.fanMembers('r1', 'g', {
      page: '2',
      size: '1000',
      filter: { failed: 'true' },
    });

    expect(seen[0]).toEqual({ offset: 500, limit: 500, failedOnly: true });
    expect(body.meta).toMatchObject({ total: 1200, perPage: 500, currentPage: 2, lastPage: 3 });
  });

  it('refuses an unknown filter field', async () => {
    const c = await makeConsole();

    await expect(c.controller.fanMembers('r1', 'g', { filter: { status: 'x' } })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('lifecycle endpoints against a control plane older than the verb', () => {
  it('answer 501 with the reason, not a 500', async () => {
    const c = await makeConsole();
    const notSupported = Object.assign(
      new Error('republishLifecycle is not supported by this server'),
      { code: 'unsupported-request' },
    );
    const service = (c.controller as unknown as { dashboard: DashboardService }).dashboard;
    service.republishLifecycle = async () => Promise.reject(notSupported);
    service.workflowLifecycle = async () => Promise.reject(notSupported);

    await expect(c.controller.republishLifecycle('run-1')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    await expect(c.controller.workflowLifecycle('checkout')).rejects.toThrow(
      /not supported by this server/,
    );
    await expect(c.controller.workflowLifecycle('checkout')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });
});
