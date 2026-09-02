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
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';
import { DurableRun } from './durable-run.js';
import type { RunQueryDraft } from './run-query-draft.js';
import { RUN_QUERY_ADAPTER, RunQueryAdapter } from './run-query.adapter.js';
import { RunFilter } from './run.filter.js';

interface Console {
  /** Request → the whole path a real one takes: filter parsing, adapter translation, controller. */
  list(input?: unknown): Promise<Awaited<ReturnType<DurableApiController['runs']>>>;
  facets(input?: unknown): Promise<RunFacetRow[]>;
  values(input: Record<string, unknown>): Promise<unknown>;
  bulk(action: 'retry' | 'cancel', input?: unknown, compensate?: string): Promise<unknown>;
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
      throw new Error('could not find');
    },
    // Typed off the constructor rather than off `ModuleRef` directly: the runner only ever calls
    // `resolve`/`get` on it, and naming the class would tie this stub to one copy of @nestjs/core.
  } as unknown as ConstructorParameters<typeof FilterRunner>[0];
  const runner = new FilterRunner(moduleRef, { validation: 'off' }, null);
  const controller = new DurableApiController(new DashboardService(gateway), runner);
  const draftFor = async (input: unknown): Promise<RunQueryDraft> => {
    const draft = adapter.createQueryBuilder(DurableRun) as RunQueryDraft;
    await runner.apply(RunFilter, input ?? {}, draft);
    return draft;
  };

  return {
    controller,
    queries,
    facetQueries,
    valueFacets,
    async list(input) {
      return controller.runs(await draftFor(input));
    },
    async facets(input) {
      return controller.facets(await draftFor(input));
    },
    values(input) {
      return controller.values(input);
    },
    async bulk(action, input, compensate) {
      return controller.bulk(action, await draftFor(input), compensate);
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

    await c.list({ namespace: 'acme', origin: '@dudousxd/agent' });

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
    // `?namespace=` is what a cleared filter box sends. Passing '' through would be an exact match
    // against a namespace nothing has — a console that goes empty for no visible reason.
    const c = await makeConsole();

    await c.list({ namespace: '', origin: '' });

    expect(c.queries[0]?.namespace).toBeUndefined();
    expect(c.queries[0]?.origin).toBeUndefined();
  });

  it('keeps the existing flat predicates working alongside the new ones', async () => {
    // The console has always sent these, and a run row's tag chip is still a plain link that sets
    // one. The structured spelling is additive, never a replacement.
    const c = await makeConsole();

    await c.list({
      status: 'dead',
      workflow: 'checkout',
      tag: 'tier:pro',
      attr: 'amount:gte:200',
      namespace: 'acme',
    });

    expect(c.queries[0]).toMatchObject({
      status: 'dead',
      workflow: 'checkout',
      tag: 'tier:pro',
      namespace: 'acme',
    });
    expect(c.queries[0]?.attributes).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
  });
});

describe('DurableApiController: multi-value predicates', () => {
  it('ORs a repeated tag param into `tags`, and keeps a single one as `tag`', async () => {
    const c = await makeConsole();

    await c.list({ tag: ['etl', 'nightly'] });
    await c.list({ tag: 'etl' });

    expect(c.queries[0]).toMatchObject({ tags: ['etl', 'nightly'] });
    expect(c.queries[0]?.tag).toBeUndefined();
    expect(c.queries[1]).toMatchObject({ tag: 'etl' });
    expect(c.queries[1]?.tags).toBeUndefined();
  });

  it('ORs repeated tenants into `namespaces`, so a few can be compared side by side', async () => {
    const c = await makeConsole();

    await c.list({ namespace: ['acme', 'globex'] });

    expect(c.queries[0]).toMatchObject({ namespaces: ['acme', 'globex'] });
  });

  it('takes the same sets through the structured `where` spelling', async () => {
    // What `filterQuery().where('tag', 'in', [...])` builds — the same predicate the console's
    // multi-select produces, arriving as an operator object rather than as repeated params.
    const c = await makeConsole();

    await c.list({
      filter: {
        where: [
          { field: 'tag', operator: 'in', value: ['etl', 'nightly'] },
          { field: 'namespace', operator: 'in', value: ['acme'] },
        ],
      },
    });

    expect(c.queries[0]).toMatchObject({ tags: ['etl', 'nightly'], namespaces: ['acme'] });
  });

  it('carries a set of search-attribute values as one `in` predicate, not two ANDed equalities', async () => {
    // Two `eq` predicates on the same key are ANDed like every other pair, and no run has one
    // attribute with two values — the multi-select would always return nothing.
    const c = await makeConsole();

    await c.list({
      filter: { where: [{ field: 'attr.tier', operator: 'in', value: ['pro', 'enterprise'] }] },
    });

    expect(c.queries[0]?.attributes).toEqual([
      { key: 'tier', op: 'in', values: ['pro', 'enterprise'] },
    ]);
  });

  it('takes the flat `key:in:a|b` spelling of the same attribute set', async () => {
    const c = await makeConsole();

    await c.list({ attr: 'tier:in:pro|enterprise' });

    expect(c.queries[0]?.attributes).toEqual([
      { key: 'tier', op: 'in', values: ['pro', 'enterprise'] },
    ]);
  });

  it('coerces attribute operands, so a numeric set compares as numbers', async () => {
    const c = await makeConsole();

    await c.list({ attr: 'amount:in:200|300' });

    expect(c.queries[0]?.attributes).toEqual([{ key: 'amount', op: 'in', values: [200, 300] }]);
  });
});

describe('DurableApiController: predicates this backend cannot express', () => {
  it('refuses an unsupported operator instead of returning a wider set', async () => {
    // Dropping the clause would answer with every run and look exactly like success.
    const c = await makeConsole();

    await expect(
      c.list({ filter: { where: [{ field: 'tag', operator: 'contains', value: 'etl' }] } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(c.queries).toEqual([]);
  });

  it('refuses a sort it cannot honour rather than silently returning another order', async () => {
    // A paginated list served in an order the client did not ask for skips and duplicates rows.
    const c = await makeConsole();

    await expect(c.list({ sort: 'workflow' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the one order a run listing actually has', async () => {
    const c = await makeConsole();

    await c.list({ sort: '-createdAt' });

    expect(c.queries).toHaveLength(1);
  });
});

describe('DurableApiController: bulk scoping', () => {
  it('carries namespace and origin into the set a bulk action acts on', async () => {
    // A bulk retry/cancel that dropped these would act on runs from tenants and libraries the
    // operator never had on screen.
    const c = await makeConsole();

    await c.bulk(
      'cancel',
      { status: 'dead', namespace: 'acme', origin: '@dudousxd/agent' },
      'true',
    );

    expect(c.queries[0]).toMatchObject({
      status: 'dead',
      namespace: 'acme',
      origin: '@dudousxd/agent',
    });
  });

  it('treats blank bulk params as absent too', async () => {
    const c = await makeConsole();

    await c.bulk('retry', { namespace: '', origin: '' });

    expect(c.queries[0]?.namespace).toBeUndefined();
    expect(c.queries[0]?.origin).toBeUndefined();
  });

  it('drops the page window, so "retry all" is not "retry the first page"', async () => {
    const c = await makeConsole();

    await c.bulk('retry', { status: 'dead', limit: '100', offset: '200' });

    expect(c.queries[0]?.offset).toBeUndefined();
    // `bulk` applies its own bound; what matters is that the operator's 100 is gone.
    expect(c.queries[0]?.limit).not.toBe(100);
  });
});

describe('DurableApiController: paging', () => {
  it('passes limit and offset straight through, so the store does the bounding', async () => {
    const c = await makeConsole();

    await c.list({ limit: '100', offset: '200' });

    expect(c.queries[0]).toMatchObject({ limit: 100, offset: 200 });
  });

  it('leaves the query unbounded when no bound is sent', async () => {
    // An existing API consumer that never sent a bound must keep getting the whole listing rather
    // than being silently truncated to some default page.
    const c = await makeConsole();

    await c.list();

    expect(c.queries[0]?.limit).toBeUndefined();
    expect(c.queries[0]?.offset).toBeUndefined();
  });

  it('ignores a bound that is not a whole non-negative number', async () => {
    // Coercing junk to 0 would return an empty page, which reads as "there are no runs".
    const c = await makeConsole();

    await c.list({ limit: 'abc', offset: '-5' });

    expect(c.queries[0]?.limit).toBeUndefined();
    expect(c.queries[0]?.offset).toBeUndefined();
  });

  it('ORs a repeated status param into `statuses`, and keeps a single one as `status`', async () => {
    const c = await makeConsole();

    await c.list({ status: ['running', 'suspended'] });
    await c.list({ status: 'dead' });

    expect(c.queries[0]).toMatchObject({ statuses: ['running', 'suspended'] });
    expect(c.queries[0]?.status).toBeUndefined();
    expect(c.queries[1]).toMatchObject({ status: 'dead' });
    expect(c.queries[1]?.statuses).toBeUndefined();
  });
});

describe('DurableApiController: the unattributed bucket', () => {
  it('asks the store for runs with NO origin, which no origin VALUE can match', async () => {
    const c = await makeConsole();

    await c.list({ unattributed: 'true' });

    expect(c.queries[0]?.origin).toBeNull();
  });

  it('selects it through the structured spelling too — the one the console sends', async () => {
    const c = await makeConsole();

    await c.list({ filter: { where: [{ field: 'origin', operator: 'isNull' }] } });

    expect(c.queries[0]?.origin).toBeNull();
  });

  it('unions with a concurrent origin — "this package plus the runs nothing claims"', async () => {
    const c = await makeConsole();

    await c.list({ origin: '@dudousxd/agent', unattributed: 'true' });

    expect(c.queries[0]?.origins).toEqual(['@dudousxd/agent', null]);
  });

  it('resolves the same way whichever order the two params arrive in', async () => {
    // `@FilterFor` dispatch follows the client's key order; the answer must not.
    const c = await makeConsole();

    await c.list({ unattributed: 'true', origin: '@dudousxd/agent' });

    expect(c.queries[0]?.origins).toEqual(['@dudousxd/agent', null]);
  });

  it('scopes a BULK action to it too — or retry-all would reach every origin', async () => {
    // The console can select this bucket, so a destructive action launched under it must be narrowed
    // to it. Sending no origin param at all would act on runs the operator never had on screen.
    const c = await makeConsole();

    await c.bulk('cancel', { unattributed: 'true' });

    expect(c.queries[0]?.origin).toBeNull();
  });
});

describe('DurableApiController: facets', () => {
  it('counts over the tag/tenant/attribute predicates the listing uses', async () => {
    const c = await makeConsole();

    await c.facets({
      workflow: 'checkout',
      tag: 'tier:pro',
      attr: 'amount:gte:200',
      namespace: 'acme',
    });

    expect(c.facetQueries[0]).toMatchObject({
      workflow: 'checkout',
      tag: 'tier:pro',
      namespace: 'acme',
    });
    expect(c.facetQueries[0]?.attributes).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
  });

  it('is not narrowed by the axes it reports, even when the request carries them', async () => {
    // Counting "how many are failed" inside a query already filtered to failed answers itself. The
    // route takes the same filter as the listing, so the dropping has to happen here.
    const c = await makeConsole();

    await c.facets({ status: 'failed', origin: '@acme/billing', limit: '10' });

    expect(c.facetQueries[0]).not.toHaveProperty('status');
    expect(c.facetQueries[0]).not.toHaveProperty('origin');
    expect(c.facetQueries[0]).not.toHaveProperty('limit');
  });
});

describe('DurableApiController: value pickers', () => {
  it('enumerates a field over the runs the OTHER filters select', async () => {
    // The whole point of scoping: pick a tenant, and the tag picker offers that tenant's tags.
    const c = await makeConsole();

    const rows = await c.values({
      filter: { where: [{ field: 'namespace', operator: 'equals', value: 'acme' }] },
      groupByCount: { field: 'tag' },
    });

    expect(c.valueFacets[0]?.axis).toEqual({ field: 'tag' });
    expect(c.valueFacets[0]?.query).toMatchObject({ namespace: 'acme' });
    expect(rows).toEqual([
      { value: 'etl', count: 4 },
      { value: 'nightly', count: 1 },
    ]);
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

    const rows = await c.list();

    expect(rows[0]).not.toHaveProperty('input');
    expect(rows[0]).not.toHaveProperty('output');
    expect(rows[0]).not.toHaveProperty('error');
  });

  it('keeps every field a row or its derived state reads', async () => {
    const c = await makeConsole([runWithPayloads()]);

    const rows = await c.list();

    expect(rows[0]).toMatchObject({
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
