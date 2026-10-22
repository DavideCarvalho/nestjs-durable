import {
  type FanPageQuery,
  InMemoryStateStore,
  type StateStore,
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { aggregationFixture } from '@dudousxd/nestjs-durable-testing';
import { describe, expect, it } from 'vitest';
import { StoreRunGateway } from './store-run-gateway';

const at = new Date('2026-06-11T00:00:00.000Z');
const run: WorkflowRun = {
  id: 'r1',
  workflow: 'lines',
  workflowVersion: '1',
  status: 'suspended',
  input: {},
  createdAt: at,
  updatedAt: at,
};

/** The same store with the aggregation pair hidden: the gateway's fallback path. */
function withoutAggregates(store: InMemoryStateStore): StateStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'checkpointStats' || key === 'queryCheckpoints') return undefined;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function seeded(rows: StepCheckpoint[]) {
  const store = new InMemoryStateStore();
  await store.createRun(run);
  for (const row of rows) await store.saveCheckpoint(row);
  const engine = new WorkflowEngine({ store });
  return {
    store,
    aggregated: new StoreRunGateway(store, engine),
    fallback: new StoreRunGateway(withoutAggregates(store), engine),
  };
}

function strip<T extends { etag?: string | undefined }>(value: T | null): Omit<T, 'etag'> | null {
  if (!value) return value;
  const { etag: _etag, ...rest } = value;
  return rest;
}

describe('StoreRunGateway over a store that aggregates checkpoints', () => {
  it('builds the same detail and fan pages as the full-read fallback', async () => {
    const { aggregated, fallback } = await seeded(aggregationFixture());
    for (const over of [50, 0, 1000]) {
      const viaStore = await aggregated.getRunDetail('r1', { summarizeFansOver: over });
      expect(viaStore?.etag).toBeDefined();
      expect(strip(viaStore)).toEqual(
        await fallback.getRunDetail('r1', { summarizeFansOver: over }),
      );
    }
    const queries: FanPageQuery[] = [
      {},
      { offset: 40, limit: 30 },
      { failedOnly: true },
      { failedOnly: true, offset: 10, limit: 5 },
    ];
    for (const group of ['steps:2:120', 'all:187:n80', 'all:300:n3000:failFast', 'absent']) {
      for (const query of queries) {
        expect(strip(await aggregated.getFanMembers('r1', group, query))).toEqual(
          await fallback.getFanMembers('r1', group, query),
        );
      }
    }
    expect(await aggregated.getFanMembers('missing', 'steps:2:120', {})).toBeNull();
    expect(await aggregated.getRunDetail('missing', { summarizeFansOver: 50 })).toBeNull();
  });

  it('answers a matching If-None-Match with the run alone, and a new one after any write', async () => {
    const { store, aggregated } = await seeded(aggregationFixture());
    const first = await aggregated.getRunDetail('r1', { summarizeFansOver: 50 });
    const etag = first?.etag as string;

    const unchanged = await aggregated.getRunDetail('r1', {
      summarizeFansOver: 50,
      ifNoneMatch: `W/${etag}, "other"`,
    });
    expect(unchanged).toEqual({
      run: await store.getRun('r1'),
      timeline: [],
      children: [],
      notModified: true,
      etag,
    });
    // Another threshold is another representation.
    const otherOver = await aggregated.getRunDetail('r1', {
      summarizeFansOver: 10,
      ifNoneMatch: etag,
    });
    expect(otherOver?.notModified).toBeUndefined();

    // A member settling in place: no new row, no new seq.
    const pending = (await store.listCheckpoints('r1')).find((cp) => cp.status === 'pending');
    await store.saveCheckpoint({ ...(pending as StepCheckpoint), status: 'completed' });
    const settled = await aggregated.getRunDetail('r1', {
      summarizeFansOver: 50,
      ifNoneMatch: etag,
    });
    expect(settled?.notModified).toBeUndefined();
    expect(settled?.etag).not.toBe(etag);

    // A failed step retried in place keeps its status and seq; its attempts move.
    const failed = (await store.listCheckpoints('r1')).find((cp) => cp.status === 'failed');
    const before = settled?.etag as string;
    await store.saveCheckpoint({ ...(failed as StepCheckpoint), attempts: 9 });
    const retried = await aggregated.getRunDetail('r1', {
      summarizeFansOver: 50,
      ifNoneMatch: before,
    });
    expect(retried?.etag).not.toBe(before);
  });

  it('versions a fan page, and answers its If-None-Match without reading members', async () => {
    const { store, aggregated } = await seeded(aggregationFixture());
    const page = await aggregated.getFanMembers('r1', 'steps:2:120', { limit: 10 });
    const etag = page?.etag as string;
    const reads = store.checkpointRowsRead;
    expect(
      await aggregated.getFanMembers('r1', 'steps:2:120', { limit: 10, ifNoneMatch: etag }),
    ).toEqual({ items: [], total: 0, notModified: true, etag });
    expect(store.checkpointRowsRead).toBe(reads);
    expect(
      (await aggregated.getFanMembers('r1', 'steps:2:120', { limit: 20, ifNoneMatch: etag }))
        ?.notModified,
    ).toBeUndefined();
  });

  it('does not version the full detail, nor a store without the aggregates', async () => {
    const { aggregated, fallback } = await seeded(aggregationFixture());
    expect((await aggregated.getRunDetail('r1'))?.etag).toBeUndefined();
    expect((await fallback.getRunDetail('r1', { summarizeFansOver: 50 }))?.etag).toBeUndefined();
    expect((await fallback.getFanMembers('r1', 'steps:2:120', {}))?.etag).toBeUndefined();
  });
});

describe('the detail of a 40,000-member fan', () => {
  const N = 40_000;
  const rows = (): StepCheckpoint[] => [
    {
      runId: 'r1',
      seq: 0,
      name: 'Lines.load',
      kind: 'local',
      stepId: 'r1:0',
      status: 'completed',
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    },
    ...Array.from(
      { length: N },
      (_, i): StepCheckpoint => ({
        runId: 'r1',
        seq: 1 + i,
        name: 'Lines.process',
        kind: 'remote',
        stepId: `r1:${1 + i}`,
        status: i % 1000 === 0 ? 'failed' : i > N - 300 ? 'pending' : 'completed',
        output: { line: i, payload: 'x'.repeat(200) },
        attempts: 1,
        parallelGroup: `steps:1:${N}`,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: new Date(at.getTime() + i),
      }),
    ),
  ];

  it('reads a handful of rows instead of the fan, for the detail and for a page', async () => {
    const { store, aggregated, fallback } = await seeded(rows());
    const measure = async (read: () => Promise<unknown>) => {
      const before = store.checkpointRowsRead;
      const started = performance.now();
      const value = await read();
      return { rows: store.checkpointRowsRead - before, ms: performance.now() - started, value };
    };
    const group = `steps:1:${N}`;
    const detailFull = await measure(() => fallback.getRunDetail('r1', { summarizeFansOver: 50 }));
    const detailAgg = await measure(() => aggregated.getRunDetail('r1', { summarizeFansOver: 50 }));
    const pageFull = await measure(() => fallback.getFanMembers('r1', group, { offset: 20_000 }));
    const pageAgg = await measure(() => aggregated.getFanMembers('r1', group, { offset: 20_000 }));
    const failedAgg = await measure(() =>
      aggregated.getFanMembers('r1', group, { failedOnly: true }),
    );
    const etag = (detailAgg.value as { etag: string }).etag;
    const poll304 = await measure(() =>
      aggregated.getRunDetail('r1', { summarizeFansOver: 50, ifNoneMatch: etag }),
    );
    console.info(
      `[40k fan] detail: fallback ${detailFull.rows} rows / ${detailFull.ms.toFixed(1)}ms, ` +
        `aggregates ${detailAgg.rows} rows / ${detailAgg.ms.toFixed(1)}ms; ` +
        `page: fallback ${pageFull.rows} rows / ${pageFull.ms.toFixed(1)}ms, ` +
        `aggregates ${pageAgg.rows} rows / ${pageAgg.ms.toFixed(1)}ms; ` +
        `failed page ${failedAgg.rows} rows; 304 poll ${poll304.rows} rows`,
    );

    expect(strip(detailAgg.value as { etag?: string })).toEqual(detailFull.value);
    expect(strip(pageAgg.value as { etag?: string })).toEqual(pageFull.value);
    expect(detailFull.rows).toBe(N + 1);
    // The ungrouped step plus the fan's first 20 failures.
    expect(detailAgg.rows).toBe(1 + 20);
    expect(pageAgg.rows).toBe(100);
    expect(failedAgg.rows).toBe(40);
    expect(poll304.rows).toBe(0);
  });
});
