import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('ctx.setEvent / engine.getEvent — live query of a running run', () => {
  it('reads the latest value a running workflow published, without disturbing it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async (ctx) => {
      await ctx.setEvent('progress', 0);
      await ctx.step('phase-1', async () => 'a');
      await ctx.setEvent('progress', 50);
      await ctx.waitForSignal('go'); // suspend so we can query mid-flight
      await ctx.setEvent('progress', 100);
      return 'done';
    });

    await startRun(engine, 'job', {}, 'r1'); // runs until the signal wait, then suspends

    expect(await engine.getEvent('r1', 'progress')).toBe(50);
    expect(await engine.getEvent('r1', 'missing')).toBeUndefined();

    await engine.signal('go', undefined); // resume to completion
    expect(await engine.getEvent<number>('r1', 'progress')).toBe(100);
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });
});
