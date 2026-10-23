import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  ControlMessage,
  RunConsumerOptions,
  RunDispatch,
  RunQueueOptions,
  Transport,
  WorkflowRun,
} from './interfaces';
import { runSchedules } from './scheduler';
import { InMemoryRunQueue } from './testing/in-memory-run-queue';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/**
 * Every way a run gets started or re-driven by an instance goes through the transport's run queue
 * once the engine consumes it, so the work spreads over the deployment instead of executing on the
 * instance that triggered it.
 */

async function until(check: () => boolean | Promise<boolean>, max = 5000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A queue transport whose dispatches and consumer registrations are recorded. */
function recorded(inner: Transport) {
  const batches: RunDispatch[][] = [];
  const consumers: RunConsumerOptions[] = [];
  const handled: string[] = [];
  const transport: Transport = {
    ...inner,
    dispatch: inner.dispatch,
    onResult: inner.onResult,
    onHeartbeat: inner.onHeartbeat,
    dispatchRuns: async (runs: RunDispatch[], opts?: RunQueueOptions) => {
      batches.push(runs);
      await inner.dispatchRuns?.(runs, opts);
    },
    onDispatchedRun: (handler, opts) => {
      consumers.push(opts);
      return (inner.onDispatchedRun as NonNullable<Transport['onDispatchedRun']>)(async (run) => {
        handled.push(run.runId);
        await handler(run);
      }, opts);
    },
  };
  const queued = () => batches.flat().map((r) => r.runId);
  return { transport, batches, consumers, handled, queued };
}

/** Two engines on one store and one run queue, both consuming; the first one's queue is recorded. */
function deployment(extra: { clock?: () => number } = {}) {
  const store = new InMemoryStateStore();
  const queue = new InMemoryRunQueue();
  const a = recorded(queue.transport());
  const engineA = new WorkflowEngine({ store, transport: a.transport, reconcileMs: 0, ...extra });
  const engineB = new WorkflowEngine({
    store,
    transport: queue.transport(),
    reconcileMs: 0,
    ...extra,
  });
  return { store, queue, a, engineA, engineB, engines: [engineA, engineB] };
}

const done = (store: InMemoryStateStore, runId: string) =>
  until(async () => (await store.getRun(runId))?.status === 'completed');

describe("a fan's children", () => {
  it('go over the run queue in a few batches of at most 500, not one by one or in-process', async () => {
    const store = new InMemoryStateStore();
    const queue = new InMemoryRunQueue();
    const a = recorded(queue.transport());
    const engine = new WorkflowEngine({ store, transport: a.transport, reconcileMs: 0 });
    const n = 1200;
    engine.register('child', '1', async (ctx, input) => (input as { i: number }).i);
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>(
        'child',
        Array.from({ length: n }, (_, i) => ({ i })),
      ),
    );
    engine.consumeRuns();
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed', 20_000);
    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: n }, (_, i) => i));
    const children = (await store.listRuns({ workflow: 'child' })).map((r) => r.id);
    expect(children).toHaveLength(n);
    // Every child was taken off the queue, and queued once.
    expect(new Set(a.handled)).toEqual(new Set(['p', ...children]));
    // Each child started once; the parent's start, and its one wake when the fan settled.
    expect(a.batches.flat().filter((r) => r.reason === 'start')).toHaveLength(n + 1);
    expect(a.batches.flat().filter((r) => r.reason === 'wake')).toEqual([
      { runId: 'p', reason: 'wake' },
    ]);
    expect(Math.max(...a.batches.map((b) => b.length))).toBeLessThanOrEqual(500);
    expect(a.batches.length).toBeLessThanOrEqual(12);
    expect(a.batches.filter((b) => b.length > 1).length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('split across two instances, each child executed once', async () => {
    const { store, engines } = deployment();
    const ran = new Map<number, string[]>();
    engines.forEach((engine, k) => {
      engine.register('child', '1', async (ctx, input) =>
        ctx.localStep('work', async () => {
          const { i } = input as { i: number };
          ran.set(i, [...(ran.get(i) ?? []), `e${k}`]);
          await pause(5);
          return i;
        }),
      );
      engine.register('parent', '1', async (ctx) =>
        ctx.all<number>(
          'child',
          Array.from({ length: 600 }, (_, i) => ({ i })),
        ),
      );
      engine.consumeRuns();
    });
    await engines[0]?.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed', 20_000);
    expect(ran.size).toBe(600);
    for (const by of ran.values()) expect(by).toHaveLength(1);
    const onB = [...ran.values()].filter(([by]) => by === 'e1').length;
    expect(onB).toBeGreaterThan(100);
    expect(onB).toBeLessThan(500);
  }, 30_000);
});

describe('the run-queue consumer', () => {
  it('takes at most 256 runs at once per instance, for its own namespace', async () => {
    const queue = new InMemoryRunQueue();
    const a = recorded(queue.transport());
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: a.transport,
      namespace: 'acme',
    });
    engine.consumeRuns();
    expect(a.consumers).toEqual([{ concurrency: 256, namespace: 'acme' }]);
  });

  it('is not started for a transport without a run queue, and runs stay in-process', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('child', '1', async (ctx, input) => (input as { i: number }).i);
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>(
        'child',
        Array.from({ length: 50 }, (_, i) => ({ i })),
      ),
    );
    expect(engine.consumeRuns()).toBeUndefined();
    await engine.start('parent', {}, 'p');
    await done(store, 'p');
    expect((await store.getRun('p'))?.output).toHaveLength(50);
  });

  it('is not started for a transport that only half implements the run queue', () => {
    const transport = { ...new InMemoryRunQueue().transport(), onDispatchedRun: undefined };
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    expect(engine.consumeRuns()).toBeUndefined();
  });

  it('runs in-process again after its stop resolves', async () => {
    const store = new InMemoryStateStore();
    const queue = new InMemoryRunQueue();
    const a = recorded(queue.transport());
    const engine = new WorkflowEngine({ store, transport: a.transport });
    engine.register('wf', '1', async () => 1);
    const stop = engine.consumeRuns();
    await stop?.();
    await engine.start('wf', {}, 'r');
    await done(store, 'r');
    expect(a.queued()).toEqual([]);
  });

  it('a custom runDispatcher wins over the run queue', async () => {
    const store = new InMemoryStateStore();
    const a = recorded(new InMemoryRunQueue().transport());
    const dispatched: string[] = [];
    const engine = new WorkflowEngine({
      store,
      transport: a.transport,
      runDispatcher: { dispatch: (runId) => void dispatched.push(runId) },
    });
    engine.register('wf', '1', async () => 1);
    engine.consumeRuns();
    await engine.start('wf', {}, 'r');
    await pause(20);
    expect(dispatched).toEqual(['r']);
    expect(a.queued()).toEqual([]);
  });

  it('does not announce a queued run to every instance over the control plane', async () => {
    const store = new InMemoryStateStore();
    const queue = new InMemoryRunQueue();
    const controlPlane = new InMemoryTransport();
    const published: ControlMessage[] = [];
    controlPlane.onControl((msg) => published.push(msg));
    const engine = new WorkflowEngine({ store, transport: queue.transport(), controlPlane });
    engine.register('wf', '1', async () => 1);
    engine.consumeRuns();
    await engine.start('wf', {}, 'r');
    await done(store, 'r');
    expect(published.filter((m) => m.kind === 'enqueued')).toEqual([]);
  });
});

describe('every instance-triggered start or re-drive goes over the run queue', () => {
  it('start', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('wf', '1', async () => 1);
      e.consumeRuns();
    }
    await engines[0]?.start('wf', {}, 'r');
    await done(store, 'r');
    expect(a.queued()).toContain('r');
  });

  it('ctx.child', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('kid', '1', async () => 2);
      e.register('wf', '1', async (ctx) => ctx.child<number>('kid', {}, 'kid-1'));
      e.consumeRuns();
    }
    await engines[0]?.start('wf', {}, 'r');
    await done(store, 'r');
    expect(a.queued()).toContain('kid-1');
  });

  it('requeue of a failed run', async () => {
    const { store, a, engines } = deployment();
    let fail = true;
    for (const e of engines) {
      e.register('wf', '1', async (ctx) =>
        ctx.localStep('s', async () => {
          if (fail) throw new Error('boom');
          return 1;
        }),
      );
      e.consumeRuns();
    }
    await engines[0]?.start('wf', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'failed');
    a.batches.length = 0;
    fail = false;
    await engines[0]?.requeue('r');
    await done(store, 'r');
    expect(a.queued()).toEqual(['r']);
  });

  it('retryWithInput', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('wf', '1', async (ctx, input) => {
        if ((input as { ok: boolean }).ok) return 1;
        throw new Error('bad input');
      });
      e.consumeRuns();
    }
    await engines[0]?.start('wf', { ok: false }, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'failed');
    const retried = await engines[0]?.retryWithInput('r', { ok: true }, 'r2');
    await done(store, retried?.runId as string);
    expect(a.queued()).toContain('r2');
  });

  it('recoverIncomplete of a run whose instance went down mid-turn', async () => {
    let now = Date.now();
    const { store, a, engines } = deployment({ clock: () => now });
    for (const e of engines) {
      e.register('wf', '1', async () => 1);
      e.consumeRuns();
    }
    const orphan: WorkflowRun = {
      id: 'orphan',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      lockedBy: 'gone',
      lockedUntil: now - 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.createRun(orphan);
    now += 1;
    await engines[0]?.recoverIncomplete(now);
    await done(store, 'orphan');
    expect(a.queued()).toContain('orphan');
  });

  it('runPending: a pending run whose queue entry was lost', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('wf', '1', async () => 1);
      e.consumeRuns();
    }
    await store.createRun({
      id: 'stray',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await engines[0]?.runPending();
    await done(store, 'stray');
    expect(a.queued()).toContain('stray');
  });

  it('resumeDueTimers', async () => {
    let now = Date.now();
    const { store, a, engines } = deployment({ clock: () => now });
    let after = 0;
    for (const e of engines) {
      e.register('wf', '1', async (ctx) => {
        await ctx.sleep(1000);
        return ctx.localStep('after', async () => {
          after += 1;
          return 1;
        });
      });
      e.consumeRuns();
    }
    await engines[0]?.start('wf', {}, 'sleeper');
    await until(async () => (await store.getRun('sleeper'))?.status === 'suspended');
    a.batches.length = 0;
    now += 2000;
    const polled = await engines[0]?.resumeDueTimers(now);
    expect(polled).toEqual([{ runId: 'sleeper', status: 'suspended' }]);
    expect(after).toBe(0);
    await done(store, 'sleeper');
    expect(a.queued()).toEqual(['sleeper']);
    expect(after).toBe(1);
  });

  it('a singleton slot freed: the next gated run', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register(
        'job',
        '1',
        async (ctx, input) => {
          await ctx.waitForSignal(`go:${(input as { id: string }).id}`);
          return 'done';
        },
        { singleton: { key: () => 'k' } },
      );
      e.consumeRuns();
    }
    await engines[0]?.start('job', { id: 'A' }, 'a');
    await until(async () => (await store.getRun('a'))?.status === 'suspended');
    await engines[0]?.start('job', { id: 'B' }, 'b');
    await until(async () => (await store.getRun('b'))?.status === 'suspended');
    a.batches.length = 0;
    await engines[0]?.signal('go:A', undefined);
    await done(store, 'a');
    await until(() => a.batches.flat().some((r) => r.runId === 'b' && r.reason === 'wake'));
    await until(async () => (await store.listSignalWaiters('go:B')).length === 1);
    await engines[1]?.signal('go:B', undefined);
    await done(store, 'b');
  });

  it('continueAsNew: the next run', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('loop', '1', async (ctx, input) => {
        const { n } = input as { n: number };
        if (n < 2) await ctx.continueAsNew({ n: n + 1 });
        return n;
      });
      e.consumeRuns();
    }
    await engines[0]?.start('loop', { n: 0 }, 'l');
    await until(async () =>
      (await store.listRuns({ workflow: 'loop', status: 'completed' })).some((r) => r.output === 2),
    );
    const continued = a.queued().filter((id) => id !== 'l');
    expect(continued.length).toBeGreaterThanOrEqual(1);
  });

  it('publishEvent: an onEvent subscriber run', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('onSignup', '1', async () => 1, { onEvent: ['user.registered'] });
      e.consumeRuns();
    }
    await engines[0]?.publishEvent('user.registered', {}, { id: 'e1' });
    const id = 'evt:e1:onSignup';
    await done(store, id);
    expect(a.queued()).toContain(id);
  });

  it('signalEntity: the entity runner on first contact', async () => {
    const { a, engines } = deployment();
    for (const e of engines) {
      e.registerEntity<{ count: number }>('counter', {
        initialState: () => ({ count: 0 }),
        handlers: {
          add: (s, by) => {
            s.count += by as number;
          },
        },
      });
      e.consumeRuns();
    }
    await engines[0]?.signalEntity('counter', 'c1', 'add', 2);
    await until(
      async () =>
        (await engines[1]?.getEntityState<{ count: number }>('counter', 'c1'))?.count === 2,
    );
    expect(a.queued().length).toBe(1);
  });

  it('a schedule firing', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('nightly', '1', async () => 1);
      e.consumeRuns();
    }
    const ids = await runSchedules(
      engines[0] as WorkflowEngine,
      [{ key: 'nightly', workflow: 'nightly', everyMs: 60_000 }],
      Date.now(),
      { sleep: async () => undefined },
    );
    expect(ids).toHaveLength(1);
    await done(store, ids[0] as string);
    expect(a.queued()).toEqual(ids);
  });
});

describe('wakes go over the run queue', () => {
  it("a child's completion wakes its parent on whichever instance takes the wake", async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('kid', '1', async (ctx) => ctx.waitForSignal<number>('kid-go'));
      e.register('wf', '1', async (ctx) => ctx.child<number>('kid', {}, 'kid-1'));
      e.consumeRuns();
    }
    await engines[0]?.start('wf', {}, 'r');
    await until(async () => (await store.getRun('kid-1'))?.status === 'suspended');
    a.batches.length = 0;
    await engines[0]?.signal('kid-go', 5);
    await done(store, 'r');
    expect((await store.getRun('r'))?.output).toBe(5);
    const wakes = a.batches.flat().filter((r) => r.reason === 'wake');
    expect(wakes.map((r) => r.runId).sort()).toEqual(['kid-1', 'r']);
  });

  it('signal resolves once the wake is queued, and the turn runs off the queue', async () => {
    const { store, a, engines } = deployment();
    for (const e of engines) {
      e.register('wf', '1', async (ctx) => ctx.waitForSignal<string>('go'));
      e.consumeRuns();
    }
    await engines[0]?.start('wf', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'suspended');
    expect(await engines[0]?.signal('go', 'x')).toEqual({ runId: 'r', status: 'suspended' });
    await done(store, 'r');
    expect(a.batches.flat()).toContainEqual({ runId: 'r', reason: 'wake' });
  });

  it('a wake dropped on a held lease is queued once the lease is free', async () => {
    const store = new InMemoryStateStore();
    const queue = new InMemoryRunQueue();
    const a = recorded(queue.transport());
    const engine = new WorkflowEngine({ store, transport: a.transport, reconcileMs: 0 });
    engine.register('wf', '1', async (ctx) => ctx.waitForSignal<string>('go'));
    engine.consumeRuns();
    await engine.start('wf', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'suspended');
    // Another instance holds the run's lease (it went down mid-turn) when the signal's wake lands.
    await store.tryLockRun('r', 'gone-pod', Date.now() + 150, Date.now());
    a.batches.length = 0;
    await engine.signal('go', 'x');
    await done(store, 'r');
    // The signal's wake, dropped on the held lease, and the re-check queued once it lapsed.
    expect(a.batches.flat().filter((r) => r.runId === 'r' && r.reason === 'wake').length).toBe(2);
  });

  it('a due timer is claimed for one lease period while its wake waits in the queue', async () => {
    let now = Date.now();
    const store = new InMemoryStateStore();
    const queue = new InMemoryRunQueue();
    const a = recorded(queue.transport());
    const engine = new WorkflowEngine({ store, transport: a.transport, clock: () => now });
    engine.register('wf', '1', async (ctx) => {
      await ctx.sleep(1000);
      return 1;
    });
    await engine.start('wf', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'suspended');
    engine.consumeRuns();
    now += 2000;
    a.batches.length = 0;
    await engine.resumeDueTimers(now);
    await engine.resumeDueTimers(now);
    // Claimed: the second poll found nothing due to queue again.
    expect(a.batches.flat()).toEqual([{ runId: 'r', reason: 'wake' }]);
    await done(store, 'r');
  });

  it('a wake the transport refused resumes the run here instead of waiting for its timer', async () => {
    const store = new InMemoryStateStore();
    const inner = new InMemoryRunQueue().transport();
    let refuse = false;
    const transport: Transport = {
      ...inner,
      dispatchRuns: async (runs, opts) => {
        if (refuse && runs.some((r) => r.reason === 'wake')) throw new Error('broker down');
        await inner.dispatchRuns?.(runs, opts);
      },
    };
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('wf', '1', async (ctx) => ctx.waitForSignal<string>('go'));
    engine.consumeRuns();
    await engine.start('wf', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'suspended');
    refuse = true;
    await engine.signal('go', 'x');
    await done(store, 'r');
    expect((await store.getRun('r'))?.output).toBe('x');
  });
});
