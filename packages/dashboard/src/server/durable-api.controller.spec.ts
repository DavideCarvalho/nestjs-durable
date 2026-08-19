import type {
  RunFacetQuery,
  RunFacetRow,
  RunGateway,
  RunListItem,
  RunQuery,
  RunWaiting,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';

/**
 * Controller → service → gateway, wired for real (no store/engine — the tenant shape), with the one
 * `RunGateway` method these paths reach recorded. Asserting on the query the GATEWAY receives is what
 * makes these tests about the filter surviving the whole trip, not just about parameter decorators.
 */
function recordingConsole(runs: RunListItem[] = []): {
  controller: DurableApiController;
  queries: RunQuery[];
  facetQueries: RunFacetQuery[];
} {
  const queries: RunQuery[] = [];
  const facetQueries: RunFacetQuery[] = [];
  const gateway: RunGateway = {
    async listRuns(query) {
      queries.push(query);
      return runs;
    },
    async runFacets(query): Promise<RunFacetRow[]> {
      facetQueries.push(query);
      return [];
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
  return {
    controller: new DurableApiController(new DashboardService(gateway)),
    queries,
    facetQueries,
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
    const { controller, queries } = recordingConsole();

    await controller.runs(undefined, undefined, undefined, undefined, 'acme', '@dudousxd/agent');

    expect(queries[0]?.namespace).toBe('acme');
    expect(queries[0]?.origin).toBe('@dudousxd/agent');
  });

  it('leaves BOTH undefined when no param is sent — the default is every tenant, every origin', async () => {
    // Core is explicit that read paths are not namespace-scoped. If this ever defaulted to a single
    // tenant, every existing operator would silently stop seeing the other tenants' runs.
    const { controller, queries } = recordingConsole();

    await controller.runs();

    expect(queries[0]?.namespace).toBeUndefined();
    expect(queries[0]?.origin).toBeUndefined();
  });

  it('treats a blank param as absent, not as a tenant named ""', async () => {
    // `?namespace=` is what a cleared filter box sends. Passing '' through would be an exact match
    // against a namespace nothing has — a console that goes empty for no visible reason.
    const { controller, queries } = recordingConsole();

    await controller.runs(undefined, undefined, undefined, undefined, '', '');

    expect(queries[0]?.namespace).toBeUndefined();
    expect(queries[0]?.origin).toBeUndefined();
  });

  it('keeps the existing predicates working alongside the new ones', async () => {
    const { controller, queries } = recordingConsole();

    await controller.runs('dead', 'checkout', 'tier:pro', 'amount:gte:200', 'acme');

    expect(queries[0]).toMatchObject({
      status: 'dead',
      workflow: 'checkout',
      tag: 'tier:pro',
      namespace: 'acme',
    });
    expect(queries[0]?.attributes).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
  });
});

describe('DurableApiController: bulk scoping', () => {
  it('carries namespace and origin into the set a bulk action acts on', async () => {
    // A bulk retry/cancel that dropped these would act on runs from tenants and libraries the
    // operator never had on screen.
    const { controller, queries } = recordingConsole();

    await controller.bulk(
      'cancel',
      'dead',
      undefined,
      undefined,
      undefined,
      'true',
      'acme',
      '@dudousxd/agent',
    );

    expect(queries[0]).toMatchObject({
      status: 'dead',
      namespace: 'acme',
      origin: '@dudousxd/agent',
    });
  });

  it('treats blank bulk params as absent too', async () => {
    const { controller, queries } = recordingConsole();

    await controller.bulk('retry', undefined, undefined, undefined, undefined, undefined, '', '');

    expect(queries[0]?.namespace).toBeUndefined();
    expect(queries[0]?.origin).toBeUndefined();
  });
});

describe('DurableApiController: paging', () => {
  it('passes limit and offset straight through, so the store does the bounding', async () => {
    const { controller, queries } = recordingConsole();

    await controller.runs(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '100',
      '200',
    );

    expect(queries[0]).toMatchObject({ limit: 100, offset: 200 });
  });

  it('leaves the query unbounded when no bound is sent', async () => {
    // An existing API consumer that never sent a bound must keep getting the whole listing rather
    // than being silently truncated to some default page.
    const { controller, queries } = recordingConsole();

    await controller.runs();

    expect(queries[0]?.limit).toBeUndefined();
    expect(queries[0]?.offset).toBeUndefined();
  });

  it('ignores a bound that is not a whole non-negative number', async () => {
    // Coercing junk to 0 would return an empty page, which reads as "there are no runs".
    const { controller, queries } = recordingConsole();

    await controller.runs(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'abc',
      '-5',
    );

    expect(queries[0]?.limit).toBeUndefined();
    expect(queries[0]?.offset).toBeUndefined();
  });

  it('ORs a repeated status param into `statuses`, and keeps a single one as `status`', async () => {
    const { controller, queries } = recordingConsole();

    await controller.runs(['running', 'suspended']);
    await controller.runs('dead');

    expect(queries[0]).toMatchObject({ statuses: ['running', 'suspended'] });
    expect(queries[0]?.status).toBeUndefined();
    expect(queries[1]).toMatchObject({ status: 'dead' });
    expect(queries[1]?.statuses).toBeUndefined();
  });
});

describe('DurableApiController: the unattributed bucket', () => {
  it('asks the store for runs with NO origin, which no origin VALUE can match', async () => {
    const { controller, queries } = recordingConsole();

    await controller.runs(undefined, undefined, undefined, undefined, undefined, undefined, 'true');

    expect(queries[0]?.origin).toBeNull();
  });

  it('wins over a concurrent origin param rather than silently ANDing two contradictions', async () => {
    const { controller, queries } = recordingConsole();

    await controller.runs(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '@dudousxd/agent',
      'true',
    );

    expect(queries[0]?.origin).toBeNull();
  });

  it('scopes a BULK action to it too — or retry-all would reach every origin', async () => {
    // The console can select this bucket, so a destructive action launched under it must be narrowed
    // to it. Sending no origin param at all would act on runs the operator never had on screen.
    const { controller, queries } = recordingConsole();

    await controller.bulk(
      'cancel',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
    );

    expect(queries[0]?.origin).toBeNull();
  });
});

describe('DurableApiController: facets', () => {
  it('counts over the tag/tenant/attribute predicates the listing uses', async () => {
    const { controller, facetQueries } = recordingConsole();

    await controller.facets('checkout', 'tier:pro', 'amount:gte:200', 'acme');

    expect(facetQueries[0]).toMatchObject({
      workflow: 'checkout',
      tag: 'tier:pro',
      namespace: 'acme',
    });
    expect(facetQueries[0]?.attributes).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
  });

  it('is not narrowable by the axes it reports', async () => {
    // Counting "how many are failed" inside a query already filtered to failed answers itself. The
    // absence of these params is the contract, so assert the signature cannot carry them.
    const { controller } = recordingConsole();

    expect(controller.facets.length).toBe(4); // workflow, tag, attr, namespace — no status/origin/paging
  });
});

describe('DurableApiController: list rows', () => {
  it('drops input, output and error — the payloads only the detail view renders', async () => {
    // Measured on a 9.5k-run control plane, `error` alone was 63% of a 12 MB listing while no list row
    // reads it.
    const { controller } = recordingConsole([runWithPayloads()]);

    const rows = await controller.runs();

    expect(rows[0]).not.toHaveProperty('input');
    expect(rows[0]).not.toHaveProperty('output');
    expect(rows[0]).not.toHaveProperty('error');
  });

  it('keeps every field a row or its derived state reads', async () => {
    const { controller } = recordingConsole([runWithPayloads()]);

    const rows = await controller.runs();

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
    const { controller } = recordingConsole([runWithPayloads()]);

    const detail = await controller.run('run-1');

    expect(detail.run.input).toEqual({ order: 'ord-1' });
    expect(detail.run.output).toEqual({ charged: false });
    expect(detail.run.error?.message).toBe('boom');
  });
});
