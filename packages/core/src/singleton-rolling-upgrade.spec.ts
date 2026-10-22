import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowRun } from './interfaces';
import { SINGLETON_ADMITTED_TAG, SINGLETON_TRACKED_TAG } from './singleton-admission';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A rolling upgrade from a replica older than 0.73 (scan-based singleton admission, no admission
 * tag) runs old and new replicas side by side. A holder an old replica admitted carries no tag, so
 * the new replicas must still count it, or a second run of the same key starts beside it.
 */

const NOW = 1_000_000;

const legacyRun = (
  id: string,
  createdAt: number,
  over: Partial<WorkflowRun> = {},
): WorkflowRun => ({
  id,
  workflow: 'job',
  workflowVersion: '1',
  status: 'running',
  input: 'legacy',
  tags: ['singleton:k'],
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
  ...over,
});

function setup() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const store = new InMemoryStateStore();
  let now = NOW;
  const engine = new WorkflowEngine({
    store,
    clock: () => now,
    runDispatcher: { dispatch: async () => undefined },
  });
  const entered: string[] = [];
  engine.register(
    'job',
    '1',
    async (ctx, input) => {
      await ctx.localStep('enter', async () => void entered.push(input as string));
      return 'done';
    },
    { singleton: { key: () => 'k' } },
  );
  return {
    store,
    engine,
    entered,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('singleton admission across a rolling upgrade', () => {
  afterEach(() => vi.useRealTimers());

  it('a new replica denies a run while an old replica holds the key, then takes over', async () => {
    const { store, engine, entered, advance, now } = setup();
    // An older run was still `pending` when an old replica admitted a newer one by its scan.
    await store.createRun(legacyRun('older', NOW - 2_000, { status: 'pending', input: 'older' }));
    await store.createRun(
      legacyRun('legacy-holder', NOW - 1_000, { lockedBy: 'old-pod', lockedUntil: NOW + 30_000 }),
    );

    expect(await engine.runOne('older')).toMatchObject({ status: 'suspended' });
    expect(entered).toEqual([]);
    const parked = await store.getRun('older');
    expect(parked?.tags).toContain(SINGLETON_TRACKED_TAG);
    expect(parked?.tags).not.toContain(SINGLETON_ADMITTED_TAG);

    // The legacy holder sleeps (old replica), still holding the slot.
    await store.updateRun('legacy-holder', {
      status: 'suspended',
      wakeAt: NOW + 60_000,
      lockedBy: undefined,
      lockedUntil: undefined,
    });
    advance(2_000);
    await engine.resumeDueTimers(now());
    expect(entered).toEqual([]);

    // It finishes on the old replica: the new admission takes over.
    await store.updateRun('legacy-holder', { status: 'completed' });
    advance(2_000);
    await engine.resumeDueTimers(now());
    await vi.waitFor(async () => expect((await store.getRun('older'))?.status).toBe('completed'));
    expect(entered).toEqual(['older']);
    expect((await store.getRun('older'))?.tags).toEqual(['singleton:k']);
    await engine.drain();
  });

  it('a fresh start is tracked from its first execution and admitted when the key is free', async () => {
    const { store, engine, entered } = setup();
    const writes: (string[] | undefined)[] = [];
    const update = store.updateRun.bind(store);
    vi.spyOn(store, 'updateRun').mockImplementation(async (id, patch) => {
      if (patch.status === 'running') writes.push(patch.tags);
      return update(id, patch);
    });
    await engine.start('job', 'fresh', 'fresh');
    expect(await engine.runOne('fresh')).toMatchObject({ status: 'completed' });
    expect(entered).toEqual(['fresh']);
    expect(writes).toEqual([['singleton:k', SINGLETON_TRACKED_TAG]]);
    expect((await store.getRun('fresh'))?.tags).toEqual(['singleton:k']);
    await engine.drain();
  });

  it('strips a user-supplied tracked marker at start', async () => {
    const { store, engine } = setup();
    await engine.start('job', 'x', 'forged', { tags: [SINGLETON_TRACKED_TAG, 'user-tag'] });
    expect((await store.getRun('forged'))?.tags).toEqual(['user-tag', 'singleton:k']);
    await engine.drain();
  });
});
