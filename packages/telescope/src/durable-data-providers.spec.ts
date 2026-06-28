import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import {
  durableDurationProvider,
  durableRecentFailuresProvider,
  durableRunsOverTimeProvider,
  durableStateBreakdownProvider,
  durableStateProvider,
  durableSuccessRateProvider,
  durableThroughputProvider,
  durableWorkerStatusProvider,
} from './durable-data-providers.js';

// Minimal fake store: only listRuns is exercised.
function fakeStore(byStatus: Record<string, unknown[]>) {
  return {
    listRuns: async ({ status }: { status?: string }) => (status ? (byStatus[status] ?? []) : []),
  };
}

function ctxWith(store: unknown): ExtensionContext {
  return {
    config: {} as ExtensionContext['config'],
    moduleRef: { get: () => store } as unknown as ExtensionContext['moduleRef'],
  };
}

// Helper for storage-based providers: fakes TELESCOPE_STORAGE.get returning { data: entries }.
function ctxWithEntries(entries: Array<{ content?: unknown; createdAt?: Date }>): ExtensionContext {
  const storage = { get: async () => ({ data: entries }) };
  return {
    config: {} as ExtensionContext['config'],
    moduleRef: { get: () => storage } as unknown as ExtensionContext['moduleRef'],
  };
}

describe('durableStateProvider', () => {
  it('defaults to counting dead runs', async () => {
    const provider = durableStateProvider();
    const result = (await provider.resolve(
      undefined,
      ctxWith(fakeStore({ dead: [{ id: 'd1' }, { id: 'd2' }], running: [{ id: 'r1' }] })),
    )) as { value: number };
    expect(result.value).toBe(2);
  });

  it('counts the requested status', async () => {
    const provider = durableStateProvider();
    const result = (await provider.resolve(
      { status: 'running' },
      ctxWith(
        fakeStore({ dead: [{ id: 'd1' }], running: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] }),
      ),
    )) as { value: number };
    expect(result.value).toBe(3);
  });
});

describe('durableRecentFailuresProvider', () => {
  it('returns failed+dead rows newest-first with an updatedAt stamp (windowMs:0 = all)', async () => {
    const provider = durableRecentFailuresProvider();
    const store = {
      listRuns: async ({ status }: { status?: string }) =>
        status === 'failed'
          ? [
              {
                id: 'f1',
                workflow: 'checkout',
                error: { message: 'boom' },
                updatedAt: new Date(1000),
              },
            ]
          : status === 'dead'
            ? [
                {
                  id: 'd1',
                  workflow: 'ship',
                  error: { message: 'dead' },
                  updatedAt: new Date(2000),
                },
              ]
            : [],
    };
    const result = (await provider.resolve({ windowMs: 0 }, ctxWith(store))) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(result.rows[0]).toEqual({
      updatedAt: '1970-01-01 00:00Z',
      workflow: 'ship',
      runId: 'd1',
      error: 'dead',
    });
    expect(result.rows[1]?.runId).toBe('f1');
  });

  it('filters out failures older than the window (default 24h)', async () => {
    const provider = durableRecentFailuresProvider();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const store = {
      listRuns: async ({ status }: { status?: string }) =>
        status === 'failed'
          ? [
              { id: 'old', workflow: 'a', error: { message: 'x' }, updatedAt: old },
              { id: 'new', workflow: 'b', error: { message: 'y' }, updatedAt: recent },
            ]
          : [],
    };
    const result = (await provider.resolve(undefined, ctxWith(store))) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(result.rows.map((r) => r.runId)).toEqual(['new']);
  });
});

// ─── durable.duration ────────────────────────────────────────────────────────

describe('durableDurationProvider', () => {
  it('computes p50/p95/p99 from run.completed durationMs (content path)', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      content: { event: 'run.completed', durationMs: (i + 1) * 10 },
      createdAt: new Date(),
    }));
    const out = (await durableDurationProvider().resolve({}, ctxWithEntries(entries))) as {
      p50: number;
      p95: number;
      p99: number;
      buckets: Array<{ label: string; count: number }>;
    };
    expect(out.p95).toBe(950);
    expect(out.p50).toBe(500);
    expect(out.p99).toBe(990);
    expect(out.buckets.length).toBeGreaterThan(0);
  });

  it('computes duration by pairing run.started -> run.completed createdAt when durationMs absent', async () => {
    const t0 = new Date('2026-06-17T10:00:00.000Z');
    const t1 = new Date('2026-06-17T10:00:05.000Z'); // 5000 ms later
    const entries = [
      { content: { event: 'run.started', runId: 'r1' }, createdAt: t0 },
      { content: { event: 'run.completed', runId: 'r1' }, createdAt: t1 },
    ];
    const out = (await durableDurationProvider().resolve({}, ctxWithEntries(entries))) as {
      p50: number;
      p95: number;
      p99: number;
      buckets: Array<{ label: string; count: number }>;
    };
    expect(out.p50).toBe(5000);
    expect(out.p95).toBe(5000);
    expect(out.buckets.length).toBeGreaterThan(0);
  });

  it('returns p95 stat when query.metric is p95', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      content: { event: 'run.completed', durationMs: (i + 1) * 100 },
      createdAt: new Date(),
    }));
    const out = (await durableDurationProvider().resolve(
      { metric: 'p95' },
      ctxWithEntries(entries),
    )) as {
      value: number;
    };
    expect(out.value).toBe(1000);
  });
});

// ─── durable.runsOverTime ─────────────────────────────────────────────────────

describe('durableRunsOverTimeProvider', () => {
  it('buckets done vs failed by time', async () => {
    const t = new Date('2026-06-17T10:00:00Z');
    const entries = [
      { content: { event: 'run.completed' }, createdAt: t },
      { content: { event: 'run.failed', workflow: 'W' }, createdAt: t },
    ];
    const out = (await durableRunsOverTimeProvider().resolve(
      { buckets: 6 },
      ctxWithEntries(entries),
    )) as { rows: Array<{ label: string; done: number; failed: number }> };
    expect(out.rows.length).toBe(6);
    const totals = out.rows.reduce(
      (a, r) => ({ done: a.done + r.done, failed: a.failed + r.failed }),
      { done: 0, failed: 0 },
    );
    expect(totals).toEqual({ done: 1, failed: 1 });
  });

  it('defaults to 24 buckets and all rows have label/done/failed', async () => {
    const out = (await durableRunsOverTimeProvider().resolve({}, ctxWithEntries([]))) as {
      rows: Array<{ label: string; done: number; failed: number }>;
    };
    expect(out.rows.length).toBe(24);
    for (const r of out.rows) {
      expect(typeof r.label).toBe('string');
      expect(r.done).toBeGreaterThanOrEqual(0);
      expect(r.failed).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── durable.successRate ──────────────────────────────────────────────────────

describe('durableSuccessRateProvider', () => {
  it('computes value, delta, and spark from a page of entries', async () => {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1h
    // current window: 8 done, 2 failed — strictly inside (now-windowMs, now]
    // prior window: 6 done, 4 failed — strictly inside (now-2*windowMs, now-windowMs]
    const entries = [
      // current window entries — all strictly after (now - windowMs)
      ...Array.from({ length: 8 }, (_, i) => ({
        content: { event: 'run.completed' },
        createdAt: new Date(now - i * 200_000 - 1),
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        content: { event: 'run.failed' },
        createdAt: new Date(now - i * 200_000 - 50_000),
      })),
      // prior window entries — all strictly after (now - 2*windowMs) and <= (now - windowMs)
      ...Array.from({ length: 6 }, (_, i) => ({
        content: { event: 'run.completed' },
        createdAt: new Date(now - windowMs - 1 - i * 200_000),
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        content: { event: 'run.failed' },
        createdAt: new Date(now - windowMs - 1 - i * 200_000 - 50_000),
      })),
    ];
    const out = (await durableSuccessRateProvider().resolve(
      { windowMs },
      ctxWithEntries(entries),
    )) as { value: number; delta?: number; spark?: number[] };
    // current = 8/10 = 0.8; prior = 6/10 = 0.6; delta ~ +0.2
    expect(out.value).toBeCloseTo(0.8, 5);
    expect(out.delta).toBeDefined();
    expect(out.spark).toBeDefined();
    expect(Array.isArray(out.spark)).toBe(true);
  });
});

// ─── durable.throughput ───────────────────────────────────────────────────────

describe('durableThroughputProvider', () => {
  it('returns completed-per-hour value with delta and spark', async () => {
    const now = Date.now();
    const windowMs = 2 * 60 * 60 * 1000; // 2h
    // 10 completed strictly in current window (> now-2h, <= now)
    // 4 completed strictly in prior window (> now-4h, <= now-2h)
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => ({
        content: { event: 'run.completed' },
        createdAt: new Date(now - i * 600_000 - 1),
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        content: { event: 'run.completed' },
        createdAt: new Date(now - windowMs - 1 - i * 600_000),
      })),
    ];
    const out = (await durableThroughputProvider().resolve(
      { windowMs },
      ctxWithEntries(entries),
    )) as { value: number; delta?: number; spark?: number[] };
    // 10 in 2h = 5/hr
    expect(out.value).toBeCloseTo(5, 5);
    expect(out.delta).toBeDefined();
    expect(out.spark).toBeDefined();
  });
});

// ─── durable.stateBreakdown ───────────────────────────────────────────────────

describe('durableStateBreakdownProvider', () => {
  it('returns segments for all statuses with color palette', async () => {
    const store = {
      listRuns: async ({ status }: { status?: string }) => {
        const counts: Record<string, number> = {
          running: 3,
          pending: 1,
          cancelling: 1,
          completed: 20,
          failed: 2,
          dead: 0,
        };
        return Array.from({ length: counts[status ?? ''] ?? 0 }, (_, i) => ({
          id: `${status}-${i}`,
        }));
      },
    };
    const out = (await durableStateBreakdownProvider().resolve({}, ctxWith(store))) as {
      segments: Array<{ label: string; value: number; color?: string }>;
    };
    expect(out.segments.length).toBe(6);
    const labels = out.segments.map((s) => s.label);
    expect(labels).toContain('running');
    expect(labels).toContain('cancelling');
    expect(labels).toContain('completed');
    const cancellingSegment = out.segments.find((s) => s.label === 'cancelling');
    expect(cancellingSegment?.value).toBe(1);
    const runningSegment = out.segments.find((s) => s.label === 'running');
    expect(runningSegment?.value).toBe(3);
    const completedSegment = out.segments.find((s) => s.label === 'completed');
    expect(completedSegment?.value).toBe(20);
    // Every segment has a color from the palette
    for (const s of out.segments) {
      expect(typeof s.color).toBe('string');
    }
  });

  it('maps completed to green and failed to red (semantically-correct palette)', async () => {
    const store = {
      listRuns: async ({ status }: { status?: string }) =>
        Array.from(
          { length: status === 'completed' ? 5 : status === 'failed' ? 2 : 0 },
          () => ({}),
        ),
    };
    const out = (await durableStateBreakdownProvider().resolve({}, ctxWith(store))) as {
      segments: Array<{ label: string; value: number; color?: string }>;
    };
    expect(out.segments.find((s) => s.label === 'completed')?.color).toBe('#34d399');
    expect(out.segments.find((s) => s.label === 'failed')?.color).toBe('#f87171');
    expect(out.segments.find((s) => s.label === 'running')?.color).toBe('#38bdf8');
  });
});

// ─── triplication dedup ───────────────────────────────────────────────────────

describe('run-level event deduplication', () => {
  // The durable engine emits each run lifecycle event on every pod (1 worker + 2 api pods), so the
  // watcher records the same run.completed 3× with identical content but distinct createdAt (±ms).
  const tripledEntries = [
    ...Array.from({ length: 3 }, (_, i) => ({
      content: { event: 'run.completed', runId: 'r1', output: 42, workflow: 'checkout' },
      createdAt: new Date(Date.now() - i),
    })),
    {
      content: { event: 'run.failed', runId: 'r2', workflow: 'ship' },
      createdAt: new Date(Date.now()),
    },
  ];

  it('throughput counts 3 identical run.completed for the same runId as 1', async () => {
    const out = (await durableThroughputProvider().resolve(
      { windowMs: 60 * 60 * 1000 },
      ctxWithEntries(tripledEntries),
    )) as { value: number };
    // 1 completed in a 1h window = 1/hr (not 3/hr).
    expect(out.value).toBeCloseTo(1, 5);
  });

  it('successRate treats the triplicated completed + one failed as 1 + 1', async () => {
    const out = (await durableSuccessRateProvider().resolve(
      { windowMs: 60 * 60 * 1000 },
      ctxWithEntries(tripledEntries),
    )) as { value: number };
    // 1 completed / (1 completed + 1 failed) = 0.5, not 3/4 = 0.75.
    expect(out.value).toBeCloseTo(0.5, 5);
  });
});

describe('durableWorkerStatusProvider', () => {
  function ctxWithHealth(health: unknown[]): ExtensionContext {
    const engine = { workerHealth: async () => health };
    return {
      config: {} as ExtensionContext['config'],
      moduleRef: { get: () => engine } as unknown as ExtensionContext['moduleRef'],
    };
  }

  it('flattens one row per live worker and renders adaptive vs. fixed status', async () => {
    const now = Date.now();
    const health = [
      {
        group: 'pipeline',
        depth: 7,
        liveWorkers: [
          {
            group: 'pipeline',
            instanceId: 'host-b:2',
            lastBeatAt: now,
            status: {
              concurrency: { mode: 'adaptive', limit: 5, min: 1, max: 16 },
              inFlight: 4,
              rssPct: 62.4,
              cpuPct: 30.6,
              throughputPerMin: 120.7,
              p95Ms: 880.2,
              lastAdjust: { at: now - 120_000, from: 8, to: 5, reason: 'shrink' },
            },
          },
          // Same group, older SDK worker with no status → graceful '—' fields.
          { group: 'pipeline', instanceId: 'host-a:1', lastBeatAt: now },
        ],
      },
    ];
    const out = (await durableWorkerStatusProvider().resolve(undefined, ctxWithHealth(health))) as {
      rows: Array<Record<string, unknown>>;
    };

    expect(out.rows).toHaveLength(2);
    // instanceId-sorted within the group: host-a:1 before host-b:2.
    expect(out.rows[0]).toMatchObject({
      group: 'pipeline',
      instanceId: 'host-a:1',
      mode: '—',
      limit: '—',
      inFlight: '—',
      saturation: '—',
      queued: 7,
      rssPct: '—',
      lastAdjust: '—',
    });
    expect(out.rows[1]).toMatchObject({
      group: 'pipeline',
      instanceId: 'host-b:2',
      mode: 'adaptive',
      limit: 5,
      minMax: '1–16',
      saturation: '4/5',
      queued: 7,
      rssPct: 62,
      cpuPct: 31,
      throughputPerMin: 121,
      p95Ms: 880,
    });
    expect(out.rows[1].lastAdjust).toMatch(/^shrink 8→5 .*ago$/);
  });

  it('sorts groups with a backlog ahead of idle groups', async () => {
    const now = Date.now();
    const worker = (group: string) => ({
      group,
      instanceId: `${group}:1`,
      lastBeatAt: now,
      status: { concurrency: { mode: 'fixed', limit: 2 }, inFlight: 0 },
    });
    const health = [
      { group: 'idle', depth: 0, liveWorkers: [worker('idle')] },
      { group: 'busy', depth: 9, liveWorkers: [worker('busy')] },
    ];
    const out = (await durableWorkerStatusProvider().resolve(undefined, ctxWithHealth(health))) as {
      rows: Array<{ group: string }>;
    };
    expect(out.rows.map((r) => r.group)).toEqual(['busy', 'idle']);
  });
});
