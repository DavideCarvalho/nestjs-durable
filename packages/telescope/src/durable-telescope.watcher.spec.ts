import {
  FatalError,
  InMemoryStateStore,
  WorkflowEngine,
  clearDurableExecutionWrappers,
  hasDurableExecutionWrappers,
} from '@dudousxd/nestjs-durable-core';
import type { RecordInput, WatcherContext } from '@dudousxd/nestjs-telescope';
import { runTraceId } from './durable-run-trace';
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
  afterEach(() => clearDurableExecutionWrappers());

  it('records a Telescope entry per engine lifecycle event', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    const watcher = new DurableTelescopeWatcher();
    watcher.register(fakeCtx(engine, records));

    engine.register('checkout', '1', async (ctx) => {
      await ctx.localStep('charge', async () => 1);
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

  it('gives run events a family the Workflows panels can read by, and step events none', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    engine.register('checkout', '1', async (ctx) => {
      await ctx.localStep('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    expect(records.map((r) => r.familyHash)).toEqual([
      'durable:run.started',
      undefined,
      undefined,
      'durable:run.completed',
    ]);
  });

  it('stamps every entry with the run trace, so a whole run is one trace', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    expect(records.length).toBeGreaterThan(0);
    expect([...new Set(records.map((r) => r.traceId))]).toEqual([runTraceId('run1')]);
  });

  it('skips the subscription (no throw) when the engine has no subscribe — thin-worker facade', () => {
    const records: RecordInput[] = [];
    // A store-less thin-worker binds WorkflowEngine to a start-only DurableStartClient (no event
    // stream). moduleRef.get returns that; the watcher must not throw and must record nothing.
    const startOnlyFacade = { start: async () => ({}) } as unknown as WorkflowEngine;
    expect(() =>
      new DurableTelescopeWatcher().register(fakeCtx(startOnlyFacade, records)),
    ).not.toThrow();
    expect(records).toEqual([]);
    // …but the execution scope IS registered: a thin worker has no local event stream and yet is
    // exactly where step handlers run, so skipping the whole registration would blind the one role
    // that does the work.
    expect(hasDurableExecutionWrappers()).toBe(true);
  });

  it('detaches its execution wrapper on unregister', () => {
    const watcher = new DurableTelescopeWatcher();
    const startOnlyFacade = { start: async () => ({}) } as unknown as WorkflowEngine;
    watcher.register(fakeCtx(startOnlyFacade, []));
    expect(hasDurableExecutionWrappers()).toBe(true);
    watcher.unregister();
    expect(hasDurableExecutionWrappers()).toBe(false);
  });

  it('tags a child run with its parent, so a whole fan is one filter away', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    engine.register('item', '1', async () => 'ok');
    engine.register('batch', '1', async (ctx) => {
      await ctx.all('item', [{}, {}]);
      return ctx.child('item', {});
    });
    await engine.start('batch', {}, 'p');
    // waitForRun settles on the parent's first suspension; wait for the whole fan instead.
    for (let i = 0; i < 200 && (await engine.getRun('p'))?.status !== 'completed'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const childRuns = new Set(
      records
        .filter((r) => r.tags?.includes('parent:p'))
        .map((r) => (r.content as { runId: string }).runId),
    );
    expect([...childRuns].sort()).toEqual(['p.all.0.0', 'p.all.0.1', 'p.child.2']);
    const parentEntry = records.find((r) => (r.content as { runId: string }).runId === 'p');
    expect(parentEntry?.tags?.some((t) => t.startsWith('parent:'))).toBe(false);
    const childEntry = records.find((r) => (r.content as { runId: string }).runId === 'p.child.2');
    expect((childEntry?.content as { parentRunId?: string }).parentRunId).toBe('p');
  });

  it('tags failed runs with "failed"', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    engine.register('wf', '1', async (ctx) =>
      ctx.localStep('boom', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');

    const failed = records.find((r) => (r.content as { event: string }).event === 'run.failed');
    expect(failed?.tags).toContain('failed');
  });

  it('tags a handoff to an onError handler with "routed" and its code', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));
    engine.register('dlq', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async () => {
        throw new FatalError('bad line', 'invalid_line');
      },
      { onError: [{ code: 'invalid_line', workflow: 'dlq' }] },
    );
    await engine.start('line', {}, 'r');
    await engine.waitForRun('r', { until: 'terminal' });

    const routed = records.find((r) => (r.content as { event: string }).event === 'run.routed');
    expect(routed?.tags).toEqual(expect.arrayContaining(['routed', 'onError:invalid_line']));
    expect((routed?.content as { name?: string }).name).toBe('dlq');
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
