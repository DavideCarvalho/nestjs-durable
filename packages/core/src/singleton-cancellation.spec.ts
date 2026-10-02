import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('cancellation during singleton admission', () => {
  it.each(['local', 'remote'] as const)(
    'preserves cancellation of a %s run while admission waits',
    async (placement) => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
      const executed = vi.fn(async () => 'done');
      if (placement === 'local') {
        engine.register('job', '1', executed, { singleton: { key: () => 'k' } });
      } else {
        engine.registerRemote('job', '1', {
          group: 'worker',
          executor: { dispatch: executed },
          singleton: { key: () => 'k' },
        });
      }
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admit = store.tryAdmitSingleton.bind(store);
      vi.spyOn(store, 'tryAdmitSingleton').mockImplementation(async (...args) => {
        entered();
        await proceed;
        return admit(...args);
      });
      await engine.start('job', {}, 'run');
      const turn = engine.runOne('run');
      try {
        await waiting;
        await engine.cancel('run');
        release();
        await turn;
        expect((await store.getRun('run'))?.status).toBe('cancelled');
        expect(executed).not.toHaveBeenCalled();
      } finally {
        release();
        await turn;
        await engine.drain();
      }
    },
  );
});
