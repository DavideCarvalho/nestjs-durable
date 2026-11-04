import { LIFECYCLE_PENDING_TAG } from '@dudousxd/nestjs-durable-core';
import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { durableDashboard } from './durable-dashboard.spec-data.js';
import {
  durableFailedTriggersProvider,
  durableLifecycleTriggersProvider,
  durableOwedLifecycleProvider,
} from './durable-data-providers.js';
import { runEventFamily } from './durable-run-family.js';

type FakeEntry = { content: { event: string } & Record<string, unknown>; createdAt: Date };

/** TELESCOPE_STORAGE.get answered by family, newest first, the way a real store does. */
function ctxWithEntries(entries: FakeEntry[]): ExtensionContext {
  const storage = {
    get: async (q: { familyHash?: string; limit?: number }) => ({
      data: entries
        .map((e) => ({ ...e, familyHash: runEventFamily(e.content.event) ?? null }))
        .filter((e) => q.familyHash === undefined || e.familyHash === q.familyHash)
        .sort((a, b) => +b.createdAt - +a.createdAt)
        .slice(0, q.limit ?? Number.POSITIVE_INFINITY),
    }),
  };
  return {
    config: {} as ExtensionContext['config'],
    moduleRef: { get: () => storage } as unknown as ExtensionContext['moduleRef'],
  };
}

const ago = (ms: number) => new Date(Date.now() - ms);

describe('runEventFamily', () => {
  it('gives lifecycle trigger events a family the Workflows panels read by', () => {
    expect(runEventFamily('run.triggered')).toBe('durable:run.triggered');
    expect(runEventFamily('run.trigger_failed')).toBe('durable:run.trigger_failed');
  });
});

describe('durableFailedTriggersProvider', () => {
  it('lists recent trigger failures once per run and subscriber, newest first', async () => {
    const failure = (runId: string, name: string, at: Date) => ({
      content: {
        event: 'run.trigger_failed',
        workflow: 'ingest',
        runId,
        name,
        error: { message: `${name} rejected` },
      },
      createdAt: at,
    });
    const out = (await durableFailedTriggersProvider().resolve(
      {},
      ctxWithEntries([
        failure('i1', 'notify', ago(60_000)),
        failure('i1', 'notify', ago(59_000)),
        failure('i2', 'audit', ago(1_000)),
        failure('old', 'audit', ago(3 * 24 * 60 * 60 * 1000)),
        { content: { event: 'run.triggered', runId: 'i3' }, createdAt: ago(1) },
      ]),
    )) as { rows: Record<string, string>[] };

    expect(out.rows.map(({ at: _at, ...row }) => row)).toEqual([
      {
        workflow: 'ingest',
        runId: 'i2',
        subscriber: 'audit',
        error: 'audit rejected',
      },
      {
        workflow: 'ingest',
        runId: 'i1',
        subscriber: 'notify',
        error: 'notify rejected',
      },
    ]);
  });
});

describe('durableOwedLifecycleProvider', () => {
  const store = (runs: unknown[], seen: unknown[] = []) => ({
    listRuns: async (query: unknown) => {
      seen.push(query);
      return runs;
    },
  });
  const ctxWith = (s: unknown) =>
    ({
      config: {},
      moduleRef: { get: () => s },
    }) as unknown as ExtensionContext;
  const runs = [
    {
      id: 'fresh',
      workflow: 'ingest',
      updatedAt: ago(5_000),
      tags: [LIFECYCLE_PENDING_TAG, 'durable:lifecycle:owed:notify'],
    },
    {
      id: 'stale',
      workflow: 'ingest',
      updatedAt: ago(10 * 60_000),
      tags: [
        LIFECYCLE_PENDING_TAG,
        'durable:lifecycle:owed:notify',
        'durable:lifecycle:owed:audit',
      ],
    },
    {
      id: 'legacy',
      workflow: 'report',
      updatedAt: ago(60 * 60_000),
      tags: [LIFECYCLE_PENDING_TAG],
    },
  ];

  it('lists settled runs still marked past the 30s grace, newest first, with who they owe', async () => {
    const seen: unknown[] = [];
    const out = (await durableOwedLifecycleProvider().resolve({}, ctxWith(store(runs, seen)))) as {
      rows: Record<string, string>[];
    };

    expect(seen).toEqual([
      expect.objectContaining({
        tag: LIFECYCLE_PENDING_TAG,
        statuses: ['completed', 'failed', 'cancelled', 'dead'],
      }),
    ]);
    expect(out.rows.map(({ settledAt: _at, ...row }) => row)).toEqual([
      { workflow: 'ingest', runId: 'stale', owed: 'notify, audit' },
      { workflow: 'report', runId: 'legacy', owed: 'every subscriber' },
    ]);
  });

  it('counts them as a stat', async () => {
    expect(
      await durableOwedLifecycleProvider().resolve({ metric: 'count' }, ctxWith(store(runs))),
    ).toEqual({ value: 2 });
  });
});

describe('lifecycle trends', () => {
  const entries: FakeEntry[] = [
    {
      content: { event: 'run.triggered', workflow: 'ingest', runId: 'i1', name: 'notify' },
      createdAt: ago(3_000),
    },
    {
      content: { event: 'run.triggered', workflow: 'ingest', runId: 'i1', name: 'notify' },
      createdAt: ago(2_900),
    },
    {
      content: { event: 'run.triggered', workflow: 'ingest', runId: 'i2', name: 'notify' },
      createdAt: ago(2_000),
    },
    {
      content: { event: 'run.triggered', workflow: 'ingest', runId: 'i2', name: 'audit' },
      createdAt: ago(1_000),
    },
    {
      content: { event: 'run.trigger_failed', workflow: 'ingest', runId: 'i3', name: 'audit' },
      createdAt: ago(500),
    },
  ];

  it('buckets triggered and failed starts over time, once per pod-recorded event', async () => {
    const out = (await durableLifecycleTriggersProvider().resolve(
      { buckets: 4 },
      ctxWithEntries(entries),
    )) as { rows: { label: string; triggered: number; failed: number }[] };
    expect(out.rows).toHaveLength(4);
    const totals = out.rows.reduce(
      (a, r) => ({ triggered: a.triggered + r.triggered, failed: a.failed + r.failed }),
      { triggered: 0, failed: 0 },
    );
    expect(totals).toEqual({ triggered: 3, failed: 1 });
  });

  it('counts triggered starts per workflow and subscriber, most first', async () => {
    expect(
      await durableLifecycleTriggersProvider().resolve(
        { metric: 'bySubscriber' },
        ctxWithEntries(entries),
      ),
    ).toEqual({
      items: [
        { label: 'ingest → notify', value: 2 },
        { label: 'ingest → audit', value: 1 },
      ],
    });
  });
});

describe('the Workflows dashboard lifecycle panels', () => {
  it('adds failed triggers and owed lifecycle events to Needs attention, and a Lifecycle section', () => {
    const d = durableDashboard({ runHref: '/durable/runs/{runId}' });
    const attention = d.sections?.find((s) => s.title === 'Needs attention');
    expect(attention?.panels.map((p) => p.title)).toEqual(
      expect.arrayContaining(['Failed triggers', 'Owed lifecycle events']),
    );
    const failed = attention?.panels.find((p) => p.title === 'Failed triggers');
    expect(failed).toMatchObject({
      kind: 'table',
      data: { provider: 'durable.failedTriggers' },
      columns: expect.arrayContaining([
        { key: 'runId', label: 'Source run', link: { href: '/durable/runs/{runId}' } },
        { key: 'subscriber', label: 'Subscriber' },
      ]),
    });
    const lifecycle = d.sections?.find((s) => s.title === 'Lifecycle');
    expect(lifecycle?.panels.map((p) => [p.title, p.data.provider, p.data.query])).toEqual([
      ['Lifecycle triggers over time', 'durable.lifecycleTriggers', undefined],
      ['Triggered by subscriber', 'durable.lifecycleTriggers', { metric: 'bySubscriber' }],
    ]);
  });
});
