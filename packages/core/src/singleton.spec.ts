import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { startRun } from './test-helpers';
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

    await startRun(engine, 'job', { id: 'A', key: 'k' }, 'a');
    await startRun(engine, 'job', { id: 'B', key: 'k' }, 'b'); // same key → gated
    // Admission runs on the gate's retry timer: A (oldest for key 'k') admits, enters, then holds the
    // slot on its signal wait; B re-checks but the slot is taken, so it stays suspended.
    now += 1000;
    await engine.resumeDueTimers(now);
    expect(ran).toEqual(['A']);
    expect((await store.getRun('b'))?.status).toBe('suspended');

    await startRun(engine, 'job', { id: 'C', key: 'other' }, 'c'); // different key → runs immediately
    now += 1000;
    await engine.resumeDueTimers(now);
    expect(ran).toEqual(['A', 'C']);

    await engine.signal('go:A', undefined); // A completes → frees the slot
    expect((await store.getRun('a'))?.status).toBe('completed');

    now += 60_000; // B's gate retries on its timer → admits + runs
    await engine.resumeDueTimers(now);
    expect(ran).toEqual(['A', 'C', 'B']);
  });
});
