import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import type { RecordInput, WatcherContext } from '@dudousxd/nestjs-telescope';
import { DurableTelescopeWatcher } from './durable-telescope.watcher';

function fakeCtx(engine: WorkflowEngine, records: RecordInput[]): WatcherContext {
  return {
    record: (input: RecordInput) => records.push(input),
    runInBatch: async (_origin, fn) => fn(),
    beginBatch: () => ({ id: 'b', end: () => {} }),
    config: {} as WatcherContext['config'],
    moduleRef: { get: () => engine } as unknown as WatcherContext['moduleRef'],
  };
}

describe('DurableTelescopeWatcher', () => {
  it('records a Telescope entry per engine lifecycle event', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    const watcher = new DurableTelescopeWatcher();
    watcher.register(fakeCtx(engine, records));

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    const events = records.map((r) => (r.content as { event: string }).event);
    expect(events).toEqual(['run.started', 'step.started', 'step.completed', 'run.completed']);
    expect(records.every((r) => r.type === 'durable')).toBe(true);
    expect(records[0]?.tags).toContain('workflow:checkout');
    expect(records[0]?.tags).toContain('run:run1');
  });

  it('tags failed runs with "failed"', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    engine.register('wf', '1', async (ctx) =>
      ctx.step('boom', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');

    const failed = records.find((r) => (r.content as { event: string }).event === 'run.failed');
    expect(failed?.tags).toContain('failed');
  });
});
