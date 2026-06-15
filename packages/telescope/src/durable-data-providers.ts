import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';
import { STATE_STORE } from '@dudousxd/nestjs-durable-core';
import type { RunStatus, StateStore } from '@dudousxd/nestjs-durable-core';

const STATE_CAP = 10_000;

/** Source C: current-state gauge from the durable store. query.status selects which (default 'dead'). */
export function durableStateProvider(): DataProvider {
  return {
    name: 'durable.state',
    async resolve(query, ctx: ExtensionContext) {
      const store = ctx.moduleRef.get(STATE_STORE, { strict: false }) as StateStore;
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
        get(q: { type?: string; limit?: number }): Promise<{ data: Array<{ content?: unknown; createdAt?: Date }> }>;
      };
      const limit = Math.min(5_000, Math.max(100, Number(query?.limit ?? 2_000)));
      const page = await storage.get({ type: 'durable', limit });

      let completed = 0;
      let failed = 0;
      const failByWorkflow = new Map<string, number>();
      for (const e of page.data) {
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

/** Source C: recent failed + dead runs as table rows (newest first). */
export function durableRecentFailuresProvider(): DataProvider {
  return {
    name: 'durable.recentFailures',
    async resolve(query, ctx: ExtensionContext) {
      const store = ctx.moduleRef.get(STATE_STORE, { strict: false }) as StateStore;
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const [failed, dead] = await Promise.all([
        store.listRuns({ status: 'failed', limit }),
        store.listRuns({ status: 'dead', limit }),
      ]);
      const rows = [...failed, ...dead]
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .slice(0, limit)
        .map((r) => ({ workflow: r.workflow, runId: r.id, error: r.error?.message ?? '' }));
      return { rows };
    },
  };
}
