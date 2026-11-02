import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noDispatch = { dispatch: () => {} };

/**
 * `execute` lets an instance re-enter a lease it holds, and it judged that from the run it was handed.
 * A resume reads that run while the same instance's timer hand-off holds its short claim, the hand-off
 * releases, and the turn starts holding nothing: another instance locks the run and both execute.
 */
describe('a turn holding only a stale read of its own lease', () => {
  it('does not run beside another instance', async () => {
    const store = new InMemoryStateStore();
    const now = Date.now();
    let running = 0;
    let most = 0;
    const flow = async (ctx: {
      localStep: (n: string, f: () => Promise<number>) => Promise<number>;
    }) =>
      ctx.localStep('work', async () => {
        running += 1;
        most = Math.max(most, running);
        await sleep(80);
        running -= 1;
        return 1;
      });
    let stale: Awaited<ReturnType<InMemoryStateStore['getRun']>> | undefined;
    const reader = new Proxy(store, {
      get(target, key) {
        if (key === 'getRun' && stale) return async () => stale;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const a = new WorkflowEngine({
      store: reader,
      instanceId: 'a',
      leaseMs: 5_000,
      runDispatcher: noDispatch,
    });
    const b = new WorkflowEngine({
      store,
      instanceId: 'b',
      leaseMs: 5_000,
      runDispatcher: noDispatch,
    });
    a.register('flow', '1', flow as never);
    b.register('flow', '1', flow as never);
    await a.start('flow', {}, 'r1').catch(() => undefined);
    await store.updateRun('r1', { status: 'suspended', wakeAt: now - 1 });
    await store.releaseRunLock('r1');
    await store.deleteCheckpoints?.('r1');
    for (const cp of await store.listCheckpoints('r1')) {
      await store.saveCheckpoint({ ...cp, status: 'running' });
    }
    // The claim is held when the resume reads, and gone by the time the turn begins.
    expect(await store.tryLockRun('r1', 'a', Date.now() + 5_000, Date.now())).toBe(true);
    stale = await store.getRun('r1');
    await store.releaseRunLock('r1');
    const first = a.resume('r1');
    await sleep(5);
    stale = undefined;
    const second = b.resume('r1');
    await Promise.allSettled([first, second]);
    expect(most).toBe(1);
  });

  function counted(store: InMemoryStateStore, instanceId = 'a') {
    const steps = { n: 0 };
    const engine = new WorkflowEngine({
      store,
      instanceId,
      leaseMs: 5_000,
      runDispatcher: noDispatch,
    });
    engine.register('flow', '1', (async (ctx: {
      localStep: (n: string, f: () => Promise<number>) => Promise<number>;
    }) =>
      ctx.localStep('work', async () => {
        steps.n += 1;
        return 1;
      })) as never);
    return {
      engine,
      steps,
      inner: engine as unknown as Record<string, (...a: never[]) => unknown>,
    };
  }

  it('a turn that just locked runs even with a losing claim of this instance in flight', async () => {
    const store = new InMemoryStateStore();
    const { engine, steps, inner } = counted(store);
    await engine.start('flow', {}, 'r2');
    await sleep(20);
    steps.n = 0;
    await store.updateRun('r2', { status: 'pending' });
    await store.deleteCheckpoints?.('r2');
    for (const cp of await store.listCheckpoints('r2'))
      await store.saveCheckpoint({ ...cp, status: 'running' });
    await store.releaseRunLock('r2');
    (inner.markClaim as (id: string) => void).call(engine, 'r2');
    const result = await engine.runOne('r2');
    (inner.unmarkClaim as (id: string) => void).call(engine, 'r2');
    expect(result?.status).toBe('completed');
    expect(steps.n).toBe(1);
  });

  it.each([
    ['still held', false],
    ['already over', true],
  ])(
    'a renewal that lands on a claim begun while it was out proves nothing: claim %s',
    async (_n, over) => {
      const shared = new InMemoryStateStore();
      let release: () => void = () => undefined;
      let sent = false;
      const held = new Proxy(shared, {
        get(target, key) {
          if (key === 'renewRunLock')
            return async (...args: [string, string, number]) => {
              sent = true;
              await new Promise<void>((r) => {
                release = r;
              });
              return shared.renewRunLock(...args);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const { engine, steps, inner } = counted(held as InMemoryStateStore);
      await engine.start('flow', {}, 'r3');
      await sleep(20);
      steps.n = 0;
      await shared.updateRun('r3', { status: 'suspended', wakeAt: Date.now() - 1 });
      for (const cp of await shared.listCheckpoints('r3'))
        await shared.saveCheckpoint({ ...cp, status: 'running' });
      await shared.releaseRunLock('r3');
      expect(await shared.tryLockRun('r3', 'a', Date.now() + 5_000, Date.now())).toBe(true);
      const turn = engine.resume('r3');
      await vi.waitFor(() => expect(sent).toBe(true));
      (inner.markClaim as (id: string) => void).call(engine, 'r3');
      if (over) (inner.unmarkClaim as (id: string) => void).call(engine, 'r3');
      release();
      await turn;
      expect(steps.n).toBe(0);
      if (!over) (inner.unmarkClaim as (id: string) => void).call(engine, 'r3');
    },
  );

  it('a mark for a turn that never reached execute is cleared', async () => {
    const store = new InMemoryStateStore();
    const { engine, inner } = counted(store);
    await engine.start('flow', {}, 'r4');
    await sleep(20);
    await store.updateRun('r4', { status: 'completed' });
    await store.releaseRunLock('r4');
    await engine.runOne('r4');
    expect((inner as unknown as { lockedForTurn: Set<string> }).lockedForTurn.size).toBe(0);
  });
});
