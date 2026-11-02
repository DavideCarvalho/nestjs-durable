import { describe, expect, it } from 'vitest';
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
});
