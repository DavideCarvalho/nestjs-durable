import { WorkflowEngine } from './engine';
import type { EngineEvent } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('WorkflowEngine — lifecycle events', () => {
  it('emits run and step events to subscribers in order', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    engine.register('wf', '1', async (ctx) => {
      await ctx.step('a', async () => 1);
      return 'ok';
    });

    await engine.start('wf', {}, 'run1');

    expect(events.map((e) => e.type)).toEqual(['run.started', 'step.completed', 'run.completed']);
    const step = events.find((e) => e.type === 'step.completed');
    expect(step?.name).toBe('a');
    expect(step?.runId).toBe('run1');
  });

  it('stops delivering after unsubscribe', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const events: EngineEvent[] = [];
    const off = engine.subscribe((e) => events.push(e));
    off();

    engine.register('wf', '1', async () => 'ok');
    await engine.start('wf', {}, 'run1');

    expect(events).toHaveLength(0);
  });
});
