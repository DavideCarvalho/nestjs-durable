import { vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StateStore, WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * Periodic recovery must only touch ORPHANS: `running`/`cancelling` runs whose lease is free or
 * expired. Every worker calls `recoverIncomplete` on every timer tick, and on a busy fleet almost
 * every running run is healthy (its lease is held and renewed). Listing all of them and issuing one
 * doomed lock-probe UPDATE per row per worker per tick is pure load on the database.
 */

const NOW = 1_000_000;

async function seed(store: InMemoryStateStore): Promise<void> {
  const base = (id: string, over: Partial<WorkflowRun>): WorkflowRun => ({
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'running',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  });
  const runs: WorkflowRun[] = [];
  // 50 healthy runs, each leased by a live instance well into the future.
  for (let i = 0; i < 50; i += 1) {
    runs.push(base(`healthy-${i}`, { lockedBy: 'other', lockedUntil: NOW + 30_000 }));
  }
  runs.push(base('crashed', { lockedBy: 'dead', lockedUntil: NOW - 1 }));
  runs.push(base('never-leased', {}));
  await Promise.all(runs.map((r) => store.createRun(r)));
}

/** The in-memory store without `listOrphanedRuns`, as a third-party store that predates it. */
function withoutOrphanQuery(store: InMemoryStateStore): StateStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'listOrphanedRuns') return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const variant of ['listOrphanedRuns', 'fallback'] as const) {
  describe(`recoverIncomplete probes orphans only (${variant})`, () => {
    it('never lock-probes a run whose lease is held', async () => {
      const inner = new InMemoryStateStore();
      await seed(inner);
      const tryLock = vi.spyOn(inner, 'tryLockRun');
      const listAll = vi.spyOn(inner, 'listIncompleteRuns');
      const store = variant === 'fallback' ? withoutOrphanQuery(inner) : inner;
      const engine = new WorkflowEngine({
        store,
        clock: () => NOW,
        runDispatcher: { dispatch: () => Promise.resolve() },
      });
      engine.register('wf', '1', async () => 'ok');

      const results = await engine.recoverIncomplete(NOW);

      expect(results.map((r) => r.runId).sort()).toEqual(['crashed', 'never-leased']);
      const probed = tryLock.mock.calls.map(([runId]) => runId).sort();
      expect(probed).toEqual(['crashed', 'never-leased']);
      if (variant === 'listOrphanedRuns') expect(listAll).not.toHaveBeenCalled();
      // The healthy runs were left alone.
      expect((await inner.getRun('healthy-0'))?.lockedBy).toBe('other');
      expect((await inner.getRun('healthy-0'))?.status).toBe('running');
    });
  });
}

describe('recoverIncomplete fallback (no listOrphanedRuns)', () => {
  it('reclaims at most one batch of 500 orphans per pass', async () => {
    const inner = new InMemoryStateStore();
    for (let i = 0; i < 600; i += 1) {
      await inner.createRun({
        id: `orphan-${i}`,
        workflow: 'wf',
        workflowVersion: '1',
        status: 'running',
        createdAt: new Date(i),
        updatedAt: new Date(i),
      });
    }
    const tryLock = vi.spyOn(inner, 'tryLockRun');
    const engine = new WorkflowEngine({
      store: withoutOrphanQuery(inner),
      clock: () => NOW,
      runDispatcher: { dispatch: () => Promise.resolve() },
    });
    engine.register('wf', '1', async () => 'ok');

    expect(await engine.recoverIncomplete(NOW)).toHaveLength(500);
    expect(tryLock).toHaveBeenCalledTimes(500);
  });
});

describe('InMemoryStateStore.listOrphanedRuns', () => {
  it('returns running and cancelling runs with a free or expired lease, oldest first, capped', async () => {
    const store = new InMemoryStateStore();
    const run = (id: string, createdAt: number, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
      id,
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
      ...over,
    });
    await store.createRun(run('held', 1, { lockedBy: 'x', lockedUntil: NOW + 1 }));
    await store.createRun(run('expired', 3, { lockedBy: 'x', lockedUntil: NOW }));
    await store.createRun(run('free', 2));
    await store.createRun(run('cancelling', 4, { status: 'cancelling' }));
    await store.createRun(run('suspended', 0, { status: 'suspended' }));
    await store.createRun(run('other-ns', 0, { namespace: 'beta' }));

    expect((await store.listOrphanedRuns(NOW, 10)).map((r) => r.id)).toEqual([
      'other-ns',
      'free',
      'expired',
      'cancelling',
    ]);
    expect((await store.listOrphanedRuns(NOW, 2, 'default')).map((r) => r.id)).toEqual([
      'free',
      'expired',
    ]);
  });
});
