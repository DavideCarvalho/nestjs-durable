import { WorkflowEngine } from './engine';
import type { EngineEvent } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('StartOptions.startAt (delayed start)', () => {
  it('parks the run on its durable wake timer and runs it once the timer is due', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    let ran = 0;
    engine.register('wf', '1', async () => {
      ran += 1;
      return 'done';
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    const started = await engine.start('wf', {}, 'delayed', { startAt: 61_000 });
    expect(started.status).toBe('suspended');
    await new Promise((r) => setTimeout(r, 20)); // an eager dispatch would have run it by now
    const parked = await store.getRun('delayed');
    expect(parked?.status).toBe('suspended');
    expect(parked?.wakeAt).toBe(61_000);
    expect(ran).toBe(0);

    // Not due yet.
    now = 60_999;
    await engine.resumeDueTimers(now);
    expect(ran).toBe(0);

    now = 61_000;
    await engine.resumeDueTimers(now);
    await engine.waitForRun('delayed', { timeoutMs: 1_000, until: 'terminal' });
    expect(ran).toBe(1);
    expect((await store.getRun('delayed'))?.status).toBe('completed');
    expect(events.some((e) => e.type === 'run.completed' && e.runId === 'delayed')).toBe(true);
  });

  it('accepts a Date, and starts at once when the time is not in the future', async () => {
    const store = new InMemoryStateStore();
    const now = 5_000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('wf', '1', async () => 'done');

    const later = await engine.start('wf', {}, 'later', { startAt: new Date(9_000) });
    expect(later.status).toBe('suspended');
    expect((await store.getRun('later'))?.wakeAt).toBe(9_000);

    const past = await engine.start('wf', {}, 'past', { startAt: 4_000 });
    expect(past.status).toBe('pending');
    const result = await engine.waitForRun('past', { timeoutMs: 1_000 });
    expect(result.status).toBe('completed');
  });
});
