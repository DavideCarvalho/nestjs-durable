import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * An explicit `resume()` of a `failed` run whose lease is still held (the turn that failed it has
 * not released it yet, or another instance holds it for a moment) must not be dropped: it waits for
 * the lease, then re-drives the run.
 */
describe('explicit resume of a failed run with a held lease', () => {
  const setup = () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let failOnce = true;
    let bRuns = 0;
    engine.register('wf', '1', async (ctx) => {
      const a = await ctx.localStep('a', async () => 10);
      return ctx.localStep('b', async () => {
        bRuns += 1;
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return a + 5;
      });
    });
    return { store, engine, bRuns: () => bRuns };
  };

  it('waits for a lease another holder releases, then completes the run', async () => {
    const { store, engine, bRuns } = setup();
    await engine.start('wf', {}, 'r1');
    expect((await engine.waitForRun('r1')).status).toBe('failed');

    // The failing turn's release has not landed yet: someone else still holds the lease.
    expect(await store.tryLockRun('r1', 'holder', Date.now() + 60_000, Date.now())).toBe(true);
    const resumed = engine.resume('r1');
    setTimeout(() => void store.releaseRunLock('r1', 'holder'), 150);

    const result = await resumed;
    expect(result.status).toBe('completed');
    expect(result.output).toBe(15);
    expect(bRuns()).toBe(2);
    await engine.drain();
  });

  it('takes over a lease that expires (a holder that went down), then completes the run', async () => {
    const { store, engine } = setup();
    await engine.start('wf', {}, 'r1');
    expect((await engine.waitForRun('r1')).status).toBe('failed');

    expect(await store.tryLockRun('r1', 'gone-pod', Date.now() + 200, Date.now())).toBe(true);
    const result = await engine.resume('r1');
    expect(result.status).toBe('completed');
    expect((await store.getRun('r1'))?.status).toBe('completed');
    await engine.drain();
  });

  it('refuses loudly, instead of dropping, when a live execution keeps the lease', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, leaseMs: 50 });
    engine.register('wf', '1', async () => {
      throw new Error('boom');
    });
    await engine.start('wf', {}, 'r1');
    expect((await engine.waitForRun('r1')).status).toBe('failed');

    expect(await store.tryLockRun('r1', 'live-pod', Date.now() + 60_000, Date.now())).toBe(true);
    await expect(engine.resume('r1')).rejects.toThrow(/lease is held by live-pod/);
    await engine.drain();
  });

  it('does not re-execute a run another holder settled while the resume waited', async () => {
    const { store, engine, bRuns } = setup();
    await engine.start('wf', {}, 'r1');
    expect((await engine.waitForRun('r1')).status).toBe('failed');

    expect(await store.tryLockRun('r1', 'holder', Date.now() + 60_000, Date.now())).toBe(true);
    const resumed = engine.resume('r1');
    setTimeout(() => {
      void store
        .updateRun('r1', { status: 'completed', output: 99, error: undefined })
        .then(() => store.releaseRunLock('r1', 'holder'));
    }, 100);

    const result = await resumed;
    expect(result.status).toBe('completed');
    expect(result.output).toBe(99);
    expect(bRuns()).toBe(1);
    await engine.drain();
  });
});
