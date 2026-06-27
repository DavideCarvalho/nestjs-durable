import { STATE_STORE_CANONICAL, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import type { RunStatus, StateStore } from '@dudousxd/nestjs-durable-core';
import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Compute the p-th percentile of a SORTED array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

type StorageEntry = { content?: unknown; createdAt?: Date };

/** Fetch the durable entry page from TELESCOPE_STORAGE. */
async function fetchEntries(ctx: ExtensionContext): Promise<StorageEntry[]> {
  const storage = ctx.moduleRef.get(TELESCOPE_STORAGE, { strict: false }) as {
    get(q: { type?: string; limit?: number }): Promise<{ data: StorageEntry[] }>;
  };
  const page = await storage.get({ type: 'durable', limit: 5_000 });
  return page.data;
}

/**
 * Split entries into current/previous equal-length windows.
 *  current:  (now - windowMs, now]
 *  previous: (now - 2*windowMs, now - windowMs]
 */
function splitWindows(
  entries: StorageEntry[],
  windowMs: number,
  now: number,
): { current: StorageEntry[]; previous: StorageEntry[] } {
  const start = now - windowMs;
  const prevStart = start - windowMs;
  return {
    current: entries.filter((e) => {
      const t = e.createdAt ? +new Date(e.createdAt) : 0;
      return t > start && t <= now;
    }),
    previous: entries.filter((e) => {
      const t = e.createdAt ? +new Date(e.createdAt) : 0;
      return t > prevStart && t <= start;
    }),
  };
}

/** Compute success rate (completed / total) for a list of entries, returns 1 when no data. */
function successRateOf(entries: StorageEntry[]): number {
  let completed = 0;
  let failed = 0;
  for (const e of entries) {
    const c = (e.content ?? {}) as { event?: string };
    if (c.event === 'run.completed') completed += 1;
    else if (c.event === 'run.failed') failed += 1;
  }
  const total = completed + failed;
  return total === 0 ? 1 : completed / total;
}

/** Run-level lifecycle events — each can legitimately occur at most once per runId. */
const RUN_LIFECYCLE_EVENTS = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.suspended',
]);

/**
 * Deduplicate run-level lifecycle entries by `${event}:${runId}`, keeping the FIRST occurrence.
 *
 * The durable engine emits each run lifecycle event on every pod (1 worker + N api pods) and the
 * watcher records on each, so a single `run.completed` for a given runId is captured multiple times
 * with identical content but distinct entry ids / createdAt (±ms) — inflating completed/failed
 * counts. A given runId can legitimately have at most ONE `run.started` and ONE terminal
 * `run.completed`/`run.failed`/`run.suspended`, so collapsing by `${event}:${runId}` is provably
 * safe. Step events and any entry without a run-level event + runId pass through untouched — a step
 * can legitimately repeat across attempts, and the watcher's step content carries no stepId/attempt
 * to key on.
 */
function dedupeRunEvents(entries: StorageEntry[]): StorageEntry[] {
  const seen = new Set<string>();
  const out: StorageEntry[] = [];
  for (const e of entries) {
    const c = (e.content ?? {}) as { event?: string; runId?: string };
    if (c.event && c.runId && RUN_LIFECYCLE_EVENTS.has(c.event)) {
      const key = `${c.event}:${c.runId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(e);
  }
  return out;
}

const STATE_CAP = 10_000;

// ─── Existing providers ───────────────────────────────────────────────────────

/** Source C: current-state gauge from the durable store. query.status selects which (default 'dead'). */
export function durableStateProvider(): DataProvider {
  return {
    name: 'durable.state',
    async resolve(query, ctx: ExtensionContext) {
      const store = ctx.moduleRef.get(STATE_STORE_CANONICAL, { strict: false }) as StateStore;
      const status = (query?.status as RunStatus) ?? 'dead';
      const runs = await store.listRuns({ status, limit: STATE_CAP });
      return { value: runs.length };
    },
  };
}

/**
 * Source A: rollups from captured `durable` entries in Telescope's own storage.
 * Reads recent run.* lifecycle entries and aggregates. Bounded by Telescope's prune
 * window (by design — this is the "history" series, not the source of truth).
 */
export function durableTimeseriesProvider(): DataProvider {
  return {
    name: 'durable.timeseries',
    async resolve(query, ctx: ExtensionContext) {
      // TELESCOPE_STORAGE.get(query) → { data: Entry[]; nextCursor }. Entry = { content, createdAt, ... }.
      const storage = ctx.moduleRef.get(TELESCOPE_STORAGE, { strict: false }) as {
        get(q: { type?: string; limit?: number }): Promise<{
          data: Array<{ content?: unknown; createdAt?: Date }>;
        }>;
      };
      const limit = Math.min(5_000, Math.max(100, Number(query?.limit ?? 2_000)));
      const page = await storage.get({ type: 'durable', limit });

      let completed = 0;
      let failed = 0;
      const failByWorkflow = new Map<string, number>();
      // Dedup triplicated lifecycle events (one event recorded on every pod) before counting.
      for (const e of dedupeRunEvents(page.data)) {
        const c = (e.content ?? {}) as { event?: string; workflow?: string };
        if (c.event === 'run.completed') completed += 1;
        else if (c.event === 'run.failed') {
          failed += 1;
          const wf = c.workflow ?? 'unknown';
          failByWorkflow.set(wf, (failByWorkflow.get(wf) ?? 0) + 1);
        }
      }
      const total = completed + failed;
      const metric = (query?.metric as string) ?? 'successRate';
      if (metric === 'successRate') return { value: total === 0 ? 1 : completed / total };
      if (metric === 'failed') return { value: failed };
      if (metric === 'total') return { value: total };
      if (metric === 'topFailures') {
        const items = [...failByWorkflow.entries()]
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value);
        return { items };
      }
      return { value: total };
    },
  };
}

/**
 * Source C: recent failed + dead runs as table rows (newest first), time-bounded.
 * Only failures updated within `query.windowMs` (default 24h) are returned, so a
 * healthy system shows an EMPTY table instead of surfacing days-old failures as if
 * they were a live incident. `windowMs: 0` disables the window (return all). Each
 * row carries a compact `updatedAt` stamp so recency is visible in the table.
 */
export function durableRecentFailuresProvider(): DataProvider {
  return {
    name: 'durable.recentFailures',
    async resolve(query, ctx: ExtensionContext) {
      const store = ctx.moduleRef.get(STATE_STORE_CANONICAL, { strict: false }) as StateStore;
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const windowMs = query?.windowMs === undefined ? 24 * 60 * 60 * 1000 : Number(query.windowMs);
      const cutoff = windowMs > 0 ? Date.now() - windowMs : 0;
      const [failed, dead] = await Promise.all([
        store.listRuns({ status: 'failed', limit }),
        store.listRuns({ status: 'dead', limit }),
      ]);
      const rows = [...failed, ...dead]
        .filter((r) => +new Date(r.updatedAt) >= cutoff)
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .slice(0, limit)
        .map((r) => ({
          // Compact UTC stamp ("YYYY-MM-DD HH:mm Z"); the generic table renderer
          // prints column values as-is, so we format here.
          updatedAt: `${new Date(r.updatedAt).toISOString().replace('T', ' ').slice(0, 16)}Z`,
          workflow: r.workflow,
          runId: r.id,
          error: r.error?.message ?? '',
        }));
      return { rows };
    },
  };
}

/**
 * Source D: per-group worker health from the engine (`WorkflowEngine.workerHealth()` — queue depth
 * vs. live worker heartbeats). `query.metric: 'starvedCount'` returns the number of groups with work
 * queued and zero live workers (the "alive but not consuming" alert state) as a stat; otherwise a
 * table, starved groups sorted first. Empty when the transport can't report health (in-process).
 */
export function durableWorkerHealthProvider(): DataProvider {
  return {
    name: 'durable.workerHealth',
    async resolve(query, ctx: ExtensionContext) {
      const engine = ctx.moduleRef.get(WorkflowEngine, { strict: false }) as WorkflowEngine;
      const health = await engine.workerHealth();
      const isStarved = (g: { depth: number; liveWorkers: unknown[] }) =>
        g.depth > 0 && g.liveWorkers.length === 0;
      if ((query?.metric as string) === 'starvedCount') {
        return { value: health.filter(isStarved).length };
      }
      const rows = health
        .slice()
        // Starved groups first, then deepest backlog — the rows that need attention rise to the top.
        .sort((a, b) => Number(isStarved(b)) - Number(isStarved(a)) || b.depth - a.depth)
        .map((g) => ({
          group: g.group,
          queued: g.depth,
          liveWorkers: g.liveWorkers.length,
          status: isStarved(g) ? 'STARVED' : 'ok',
        }));
      return { rows };
    },
  };
}

// ─── New golden-signals providers ────────────────────────────────────────────

/**
 * Duration percentiles (p50/p95/p99) + a histogram of ~8 buckets.
 * Durations are read from `content.durationMs` on `run.completed`/`run.failed`; when absent,
 * computed by pairing a `run.started` and its corresponding `run.completed`/`run.failed` entry
 * by `runId` using their `createdAt` timestamps.
 *
 * With `query.metric === 'p50'|'p95'|'p99'` returns `{ value }` for use as a stat panel.
 */
export function durableDurationProvider(): DataProvider {
  return {
    name: 'durable.duration',
    async resolve(query, ctx: ExtensionContext) {
      // Dedup triplicated lifecycle events so paired durations aren't double-counted.
      const entries = dedupeRunEvents(await fetchEntries(ctx));

      // Index run.started entries by runId for the pairing fallback.
      const startedAt = new Map<string, number>();
      for (const e of entries) {
        const c = (e.content ?? {}) as { event?: string; runId?: string };
        if (c.event === 'run.started' && c.runId && e.createdAt) {
          startedAt.set(c.runId, +new Date(e.createdAt));
        }
      }

      const durs: number[] = [];
      for (const e of entries) {
        const c = (e.content ?? {}) as { event?: string; runId?: string; durationMs?: number };
        if (c.event === 'run.completed' || c.event === 'run.failed') {
          if (typeof c.durationMs === 'number') {
            durs.push(c.durationMs);
          } else if (c.runId) {
            const start = startedAt.get(c.runId);
            const end = e.createdAt ? +new Date(e.createdAt) : undefined;
            if (start !== undefined && end !== undefined && end >= start) {
              durs.push(end - start);
            }
          }
        }
      }
      durs.sort((a, b) => a - b);

      const p50 = percentile(durs, 50);
      const p95 = percentile(durs, 95);
      const p99 = percentile(durs, 99);

      // Stat shortcut: return a single value for use in stat panels.
      const metric = (query as Record<string, unknown>)?.metric as string | undefined;
      if (metric === 'p50') return { value: p50 };
      if (metric === 'p95') return { value: p95 };
      if (metric === 'p99') return { value: p99 };

      // Build ~8 equal-width buckets between 0 and max.
      const max = durs.at(-1) ?? 0;
      const bucketCount = 8;
      const size = Math.max(1, Math.ceil((max + 1) / bucketCount));
      const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        label: `${Math.round((i * size) / 100) / 10}s`,
        count: 0,
      }));
      for (const d of durs) {
        const bi = Math.min(bucketCount - 1, Math.floor(d / size));
        const bucket = buckets[bi];
        if (bucket) bucket.count += 1;
      }

      return { buckets, p50, p95, p99 };
    },
  };
}

/**
 * Buckets `run.completed` (-> done) and `run.failed` (-> failed) entries by `createdAt` into
 * N=`query.buckets ?? 24` equal-width time buckets.  Returns `{ rows: Array<{ label; done; failed }> }`.
 */
export function durableRunsOverTimeProvider(): DataProvider {
  return {
    name: 'durable.runsOverTime',
    async resolve(query, ctx: ExtensionContext) {
      const entries = dedupeRunEvents(await fetchEntries(ctx));
      const n = Number((query as Record<string, unknown>)?.buckets ?? 24);
      const now = Date.now();

      // Determine the time window from the oldest entry or default to 24h.
      let minT = now;
      for (const e of entries) {
        if (e.createdAt) {
          const t = +new Date(e.createdAt);
          if (t < minT) minT = t;
        }
      }
      const span = Math.max(now - minT, 1);
      const bucketSize = span / n;

      const rows: Array<{ label: string; done: number; failed: number }> = Array.from(
        { length: n },
        (_, i) => {
          const bucketStart = new Date(minT + i * bucketSize);
          const label = bucketStart.toISOString().slice(11, 16); // "HH:mm"
          return { label, done: 0, failed: 0 };
        },
      );

      for (const e of entries) {
        const c = (e.content ?? {}) as { event?: string };
        if (c.event !== 'run.completed' && c.event !== 'run.failed') continue;
        const t = e.createdAt ? +new Date(e.createdAt) : 0;
        const idx = Math.min(n - 1, Math.floor((t - minT) / bucketSize));
        const row = rows[idx];
        if (row) {
          if (c.event === 'run.completed') row.done += 1;
          else row.failed += 1;
        }
      }

      return { rows };
    },
  };
}

/**
 * Success rate over the last `query.windowMs` (default 24h), with a `delta` vs. the previous
 * equal-length window and a `spark` array of per-sub-bucket success rates.
 */
export function durableSuccessRateProvider(): DataProvider {
  return {
    name: 'durable.successRate',
    async resolve(query, ctx: ExtensionContext) {
      const entries = dedupeRunEvents(await fetchEntries(ctx));
      const windowMs = Number((query as Record<string, unknown>)?.windowMs ?? 24 * 60 * 60 * 1000);
      const now = Date.now();
      const { current, previous } = splitWindows(entries, windowMs, now);

      const value = successRateOf(current);
      const prevRate = successRateOf(previous);
      const delta = previous.length > 0 ? value - prevRate : undefined;

      // Spark: split the current window into 8 sub-buckets.
      const sparkBuckets = 8;
      const bucketSize = windowMs / sparkBuckets;
      const sparkStart = now - windowMs;
      const spark = Array.from({ length: sparkBuckets }, (_, i) => {
        const bStart = sparkStart + i * bucketSize;
        const bEnd = bStart + bucketSize;
        const bEntries = current.filter((e) => {
          const t = e.createdAt ? +new Date(e.createdAt) : 0;
          return t > bStart && t <= bEnd;
        });
        return successRateOf(bEntries);
      });

      return { value, delta, spark };
    },
  };
}

/**
 * Completed runs per hour over the last `query.windowMs` (default 24h), with a `delta` vs. the
 * previous equal-length window and a `spark` array of per-sub-bucket throughput values.
 */
export function durableThroughputProvider(): DataProvider {
  return {
    name: 'durable.throughput',
    async resolve(query, ctx: ExtensionContext) {
      const entries = dedupeRunEvents(await fetchEntries(ctx));
      const windowMs = Number((query as Record<string, unknown>)?.windowMs ?? 24 * 60 * 60 * 1000);
      const now = Date.now();
      const { current, previous } = splitWindows(entries, windowMs, now);

      const countCompleted = (es: StorageEntry[]) =>
        es.filter((e) => ((e.content ?? {}) as { event?: string }).event === 'run.completed')
          .length;

      const windowHours = windowMs / (60 * 60 * 1000);
      const value = countCompleted(current) / windowHours;
      const prevValue = countCompleted(previous) / windowHours;
      const delta = previous.length > 0 ? value - prevValue : undefined;

      // Spark: 8 sub-buckets of current window.
      const sparkBuckets = 8;
      const bucketSize = windowMs / sparkBuckets;
      const bucketHours = bucketSize / (60 * 60 * 1000);
      const sparkStart = now - windowMs;
      const spark = Array.from({ length: sparkBuckets }, (_, i) => {
        const bStart = sparkStart + i * bucketSize;
        const bEnd = bStart + bucketSize;
        const bEntries = current.filter((e) => {
          const t = e.createdAt ? +new Date(e.createdAt) : 0;
          return t > bStart && t <= bEnd;
        });
        return countCompleted(bEntries) / bucketHours;
      });

      return { value, delta, spark };
    },
  };
}

// Palette aligned index-for-index with STATE_BREAKDOWN_STATUSES so each status reads with the
// semantically-correct color: running=cyan, pending=amber, cancelling=orange, completed=green,
// failed=red, dead=purple.
const STATE_BREAKDOWN_STATUSES: RunStatus[] = [
  'running',
  'pending',
  'cancelling',
  'completed',
  'failed',
  'dead',
];
/** Color palette for the state breakdown pie segments (aligned to STATE_BREAKDOWN_STATUSES). */
const STATE_BREAKDOWN_PALETTE = [
  '#38bdf8', // running   → cyan/blue
  '#fbbf24', // pending   → amber
  '#f59e0b', // cancelling → orange
  '#34d399', // completed → green
  '#f87171', // failed    → red
  '#a78bfa', // dead      → purple
];

/**
 * Counts from `STATE_STORE.listRuns({ status })` for each of the statuses and returns pie
 * segments with the standard palette: `{ segments: Array<{ label, value, color }> }`.
 */
export function durableStateBreakdownProvider(): DataProvider {
  return {
    name: 'durable.stateBreakdown',
    async resolve(_query, ctx: ExtensionContext) {
      const store = ctx.moduleRef.get(STATE_STORE_CANONICAL, { strict: false }) as StateStore;
      const counts = await Promise.all(
        STATE_BREAKDOWN_STATUSES.map((status) =>
          store.listRuns({ status, limit: STATE_CAP }).then((runs) => runs.length),
        ),
      );
      const segments = STATE_BREAKDOWN_STATUSES.map((label, i) => ({
        label,
        value: counts[i],
        color: STATE_BREAKDOWN_PALETTE[i],
      }));
      return { segments };
    },
  };
}

// NOTE: durableRetryHotspotsProvider is NOT implemented.
// StateStore only exposes `listCheckpoints(runId: string)` (per-run lookup), with no cross-run
// query by step `attempts`. There is no API to enumerate all step checkpoints across runs without
// first listing every run — which would be O(N*M) and impractical. Task 13 should omit that panel.
