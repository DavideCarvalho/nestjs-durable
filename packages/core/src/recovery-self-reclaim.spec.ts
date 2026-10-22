import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StateStore, WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A pod with a stable `instanceId` (pinned to its pod identity) that is killed without a graceful
 * shutdown (OOM, SIGKILL) leaves its runs `running` under leases that are still live. When it comes
 * back with the SAME id, its recovery takes them back at once instead of waiting out `leaseMs`; any
 * other instance still waits for the lease to expire. A run the live process is itself executing is
 * never reclaimed by its own recovery.
 */

const NOW = 1_000_000;
const LEASE_MS = 30_000;

const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'running',
  input: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

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

/** A store whose `listOrphanedRuns` predates the `ownedBy` argument (it ignores it). */
function withLegacyOrphanQuery(store: InMemoryStateStore): StateStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'listOrphanedRuns') {
        return (nowMs: number, limit: number, namespace?: string) =>
          target.listOrphanedRuns(nowMs, limit, namespace);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function engineFor(store: StateStore, instanceId: string, clock: () => number = () => NOW) {
  const dispatched: string[] = [];
  const engine = new WorkflowEngine({
    store,
    instanceId,
    clock,
    leaseMs: LEASE_MS,
    runDispatcher: {
      dispatch: async (id) => {
        dispatched.push(id);
      },
    },
  });
  engine.register('wf', '1', async () => 'ok');
  return { engine, dispatched };
}

for (const variant of ['listOrphanedRuns', 'fallback'] as const) {
  describe(`recoverIncomplete reclaims its own crashed leases (${variant})`, () => {
    const wrap = (inner: InMemoryStateStore) =>
      variant === 'fallback' ? withoutOrphanQuery(inner) : inner;

    it('a process rebooted with the same instanceId reclaims at once', async () => {
      const inner = new InMemoryStateStore();
      // Leased by the previous `pod-a` process a moment before it was SIGKILLed: still live.
      await inner.createRun(run('crashed', { lockedBy: 'pod-a', lockedUntil: NOW + 25_000 }));
      // Another pod's live lease is untouched.
      await inner.createRun(run('other-pod', { lockedBy: 'pod-b', lockedUntil: NOW + 25_000 }));
      const { engine, dispatched } = engineFor(wrap(inner), 'pod-a');

      const results = await engine.recoverIncomplete(NOW);

      expect(results).toEqual([{ runId: 'crashed', status: 'pending' }]);
      expect(dispatched).toEqual(['crashed']);
      expect((await inner.getRun('crashed'))?.status).toBe('pending');
      expect((await inner.getRun('crashed'))?.recoveryAttempts).toBe(1);
      expect(await inner.getRun('other-pod')).toMatchObject({
        status: 'running',
        lockedBy: 'pod-b',
      });
    });

    it('another instance still waits for the lease to expire', async () => {
      const inner = new InMemoryStateStore();
      await inner.createRun(run('crashed', { lockedBy: 'pod-a', lockedUntil: NOW + 25_000 }));
      const { engine, dispatched } = engineFor(wrap(inner), 'pod-b');

      expect(await engine.recoverIncomplete(NOW)).toEqual([]);
      expect(dispatched).toEqual([]);
      expect(await engine.recoverIncomplete(NOW + 25_000)).toEqual([
        { runId: 'crashed', status: 'pending' },
      ]);
    });

    it('never reclaims a lease this live process took itself', async () => {
      const inner = new InMemoryStateStore();
      let now = NOW;
      const { engine, dispatched } = engineFor(wrap(inner), 'pod-a', () => now);
      await inner.createRun(run('mine'));
      now += 1_000;
      // Taken by THIS process (e.g. a `runOne` pickup whose turn has not started yet).
      expect(await inner.tryLockRun('mine', 'pod-a', now + LEASE_MS, now)).toBe(true);

      expect(await engine.recoverIncomplete(now)).toEqual([]);
      expect(dispatched).toEqual([]);
      expect(await inner.getRun('mine')).toMatchObject({ status: 'running', lockedBy: 'pod-a' });
    });
  });
}

describe('self-reclaim and in-process executions', () => {
  it('never reclaims a run this process is executing under the inherited lease', async () => {
    const inner = new InMemoryStateStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const dispatched: string[] = [];
    const engine = new WorkflowEngine({
      store: inner,
      instanceId: 'pod-a',
      clock: () => NOW,
      leaseMs: LEASE_MS,
      runDispatcher: { dispatch: async (id) => void dispatched.push(id) },
    });
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('enter', async () => {
        entered += 1;
      });
      await gate;
      return 'ok';
    });
    // The previous `pod-a` process held the lease; this one resumes the run under that same lease
    // (the engine re-enters a lease its own instance id holds) before its recovery pass runs.
    await inner.createRun(run('busy', { lockedBy: 'pod-a', lockedUntil: NOW + 25_000 }));
    const execution = engine.resume('busy');
    await vi.waitFor(() => expect(entered).toBe(1));

    expect(await engine.recoverIncomplete(NOW)).toEqual([]);
    expect(dispatched).toEqual([]);
    expect((await inner.getRun('busy'))?.recoveryAttempts).toBeUndefined();

    release();
    expect(await execution).toMatchObject({ runId: 'busy', status: 'completed' });
    expect(entered).toBe(1);
    await engine.drain();
  });

  it('a resume landing while its own lease is reclaimed queues behind the recovery', async () => {
    const inner = new InMemoryStateStore();
    let entered = 0;
    const engine = new WorkflowEngine({
      store: inner,
      instanceId: 'pod-a',
      clock: () => NOW,
      leaseMs: LEASE_MS,
      runDispatcher: { dispatch: async () => undefined },
    });
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('enter', async () => {
        entered += 1;
      });
      return 'ok';
    });
    await inner.createRun(run('crashed', { lockedBy: 'pod-a', lockedUntil: NOW + 25_000 }));
    // Slow the recovery's re-read down so a resume can land in the middle of it.
    const getRun = inner.getRun.bind(inner);
    let resumed: Promise<unknown> | undefined;
    vi.spyOn(inner, 'getRun').mockImplementation(async (id) => {
      if (!resumed) resumed = engine.resume(id);
      return getRun(id);
    });

    const results = await engine.recoverIncomplete(NOW);
    expect(results).toEqual([{ runId: 'crashed', status: 'pending' }]);
    expect(await resumed).toMatchObject({ runId: 'crashed', status: 'completed' });
    expect(entered).toBe(1);
    await engine.drain();
  });
});

describe('self-reclaim with a store predating the ownedBy argument', () => {
  it('keeps the plain behaviour: the own lease is reclaimed once it expires', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(run('crashed', { lockedBy: 'pod-a', lockedUntil: NOW + 25_000 }));
    const { engine } = engineFor(withLegacyOrphanQuery(inner), 'pod-a');

    expect(await engine.recoverIncomplete(NOW)).toEqual([]);
    expect(await engine.recoverIncomplete(NOW + 25_000)).toEqual([
      { runId: 'crashed', status: 'pending' },
    ]);
  });
});

describe('InMemoryStateStore.listOrphanedRuns ownedBy', () => {
  it('adds live leases of the owner that expire strictly before the cutoff', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('old-own', { lockedBy: 'a', lockedUntil: NOW + 10 }));
    await store.createRun(run('at-cutoff', { lockedBy: 'a', lockedUntil: NOW + 20 }));
    await store.createRun(run('foreign', { lockedBy: 'b', lockedUntil: NOW + 10 }));
    await store.createRun(
      run('parked', { status: 'suspended', lockedBy: 'a', lockedUntil: NOW + 10 }),
    );

    expect(await store.listOrphanedRuns(NOW, 10)).toEqual([]);
    expect(
      (
        await store.listOrphanedRuns(NOW, 10, undefined, { owner: 'a', lockedBefore: NOW + 20 })
      ).map((r) => r.id),
    ).toEqual(['old-own']);
  });
});
