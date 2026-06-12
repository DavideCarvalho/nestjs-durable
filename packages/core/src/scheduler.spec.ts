import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { runSchedules } from './scheduler';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('runSchedules', () => {
  it('fires each time window exactly once (idempotent by bucket)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('beat', '1', async () => {
      runs += 1;
      return 'tick';
    });
    const schedules = [{ key: 'beat', workflow: 'beat', everyMs: 1000 }];

    await runSchedules(engine, schedules, 1000); // bucket 1
    await runSchedules(engine, schedules, 1500); // same bucket → no duplicate
    expect(runs).toBe(1);

    await runSchedules(engine, schedules, 2000); // bucket 2 → fires again
    expect(runs).toBe(2);

    expect((await store.getRun('sched:beat:1'))?.output).toBe('tick');
    expect((await store.getRun('sched:beat:2'))?.output).toBe('tick');
  });

  it('start() is idempotent — re-triggering an existing run id is a no-op', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('once', '1', async () => {
      runs += 1;
      return runs;
    });
    const a = await engine.start('once', {}, 'fixed-id');
    const b = await engine.start('once', {}, 'fixed-id'); // redelivered trigger
    expect(runs).toBe(1);
    expect(b.status).toBe('completed');
    expect(a.output).toBe(b.output);
  });
});
