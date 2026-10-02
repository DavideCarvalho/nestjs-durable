import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('state-store rejection handling', () => {
  it('keeps a handled runOne rejection from creating an unhandled tracking promise', async () => {
    const store = new InMemoryStateStore();
    const outage = new Error('checkpoint connection lost');
    vi.spyOn(store, 'listCheckpoints').mockRejectedValue(outage);
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('job', '1', async () => 'done');
    await engine.start('job', {}, 'run');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(engine.runOne('run')).rejects.toBe(outage);
      await expect(engine.drain()).resolves.toBeUndefined();
      await setImmediate();
      expect(unhandled).not.toHaveBeenCalled();
      expect((engine as unknown as { inflight: Set<unknown> }).inflight.size).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each(['settled', 'terminal'] as const)(
    'rejects a %s wait on store failure and removes its listener and timers',
    async (until) => {
      const store = new InMemoryStateStore();
      const outage = new Error('run lookup connection lost');
      const lookup = vi.spyOn(store, 'getRun').mockRejectedValue(outage);
      const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
      const off = vi.fn();
      vi.spyOn(engine, 'subscribe').mockReturnValue(off);
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        await expect(engine.waitForRun('run', { until, timeoutMs: 30 })).rejects.toBe(outage);
        await new Promise((resolve) => setTimeout(resolve, 280));
        expect(off).toHaveBeenCalledOnce();
        expect(lookup).toHaveBeenCalledOnce();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        await engine.drain();
      }
    },
  );
});
