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

  it('records durationMs from run.completed events', () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];

    // Intercept the listener that the watcher registers so we can drive it with a synthetic event.
    let capturedListener:
      | ((
          event: Parameters<typeof engine.subscribe>[0] extends (e: infer E) => unknown ? E : never,
        ) => void)
      | undefined;
    const origSubscribe = engine.subscribe.bind(engine);
    engine.subscribe = (listener) => {
      capturedListener = listener as typeof capturedListener;
      return origSubscribe(listener);
    };

    new DurableTelescopeWatcher().register(fakeCtx(engine, records));
    expect(capturedListener).toBeDefined();

    // Drive the listener with a synthetic run.completed that carries durationMs.
    // (capturedListener is asserted defined above; ?. satisfies the linter.)
    capturedListener?.({
      type: 'run.completed',
      runId: 'r1',
      workflow: 'W',
      durationMs: 1234,
      at: new Date(),
    });

    const completed = records.find(
      (r) => (r.content as { event: string }).event === 'run.completed',
    );
    expect(completed).toBeDefined();
    expect((completed?.content as { durationMs?: number }).durationMs).toBe(1234);
  });
});
