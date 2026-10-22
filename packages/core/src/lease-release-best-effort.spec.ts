import { vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A lease release that fails must not become the run's outcome.
 *
 * The turn's `finally` releases the recovery lease, on the failure path too, where the thing that
 * failed the run is very often the same store the release has to talk to (a step that violated a
 * DB constraint leaves Postgres refusing every further statement on that connection). A throwing
 * `finally` replaces the workflow's real result with a lease write nobody asked about, and when the
 * turn is driven as a background resume it surfaces as an unhandled rejection instead.
 */
describe('lease release is best-effort', () => {
  const poison = () =>
    new Error('current transaction is aborted, commands ignored until end of transaction block');

  it('keeps the workflow error when releasing the lease throws', async () => {
    const store = new InMemoryStateStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new WorkflowEngine({ store });
    engine.register('poisoned', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      await ctx.localStep('persist', async () => {
        throw new Error('null value in column "value" violates not-null constraint');
      });
      return 'done';
    });
    expect((await startRun(engine, 'poisoned', {}, 'r1')).status).toBe('suspended');

    vi.spyOn(store, 'releaseRunLock').mockRejectedValue(poison());
    // The signal drives the turn inline: its result is the turn's result, not the release failure.
    const result = await engine.signal('go', null);

    expect(result?.status).toBe('failed');
    expect(result?.error?.message).toContain('not-null constraint');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/releasing the lease of run r1 failed/);
    warn.mockRestore();
  });

  it('does not reject a resume when the release fails on a successful run', async () => {
    const store = new InMemoryStateStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new WorkflowEngine({ store });
    engine.register('happy', '1', async (ctx) => {
      await ctx.waitForSignal('go-happy');
      await ctx.localStep('work', async () => 'ok');
      return 'done';
    });
    expect((await startRun(engine, 'happy', {}, 'r2')).status).toBe('suspended');

    vi.spyOn(store, 'releaseRunLock').mockRejectedValue(new Error('connection lost'));
    const result = await engine.signal('go-happy', null);
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('done');
    expect((await store.getRun('r2'))?.status).toBe('completed');
    warn.mockRestore();
  });
});
