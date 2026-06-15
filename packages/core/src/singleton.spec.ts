import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('singleton (serialize runs by key)', () => {
  it('runs one at a time per key; the next admits when the first completes', async () => {
    const store = new InMemoryStateStore();
    let now = 1000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const ran: string[] = [];

    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        const { id } = input as { id: string };
        await ctx.step('enter', async () => void ran.push(id)); // once-only (checkpointed)
        await ctx.waitForSignal(`go:${id}`); // hold the slot until signalled
        return 'done';
      },
      { singleton: { key: (input) => (input as { key: string }).key } },
    );

    await engine.start('job', { id: 'A', key: 'k' }, 'a');
    await engine.start('job', { id: 'B', key: 'k' }, 'b'); // same key → gated
    expect(ran).toEqual(['A']);
    expect((await store.getRun('b'))?.status).toBe('suspended');

    await engine.start('job', { id: 'C', key: 'other' }, 'c'); // different key → runs immediately
    expect(ran).toEqual(['A', 'C']);

    await engine.signal('go:A', undefined); // A completes → frees the slot
    expect((await store.getRun('a'))?.status).toBe('completed');

    now += 60_000; // B's gate retries on its timer → admits + runs
    await engine.resumeDueTimers(now);
    expect(ran).toEqual(['A', 'C', 'B']);
  });
});
