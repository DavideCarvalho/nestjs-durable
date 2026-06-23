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
});
