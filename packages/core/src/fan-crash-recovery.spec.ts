import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  HistoryEvent,
  RemoteTask,
  StateStore,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
} from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/**
 * A wide `ctx.all` of children under a crash or a scale-down: every completion that a crash can drop
 * is recovered by the engine itself, and the instance hosting the parent stays bounded in how much
 * work it holds at once.
 */

const LINE = 'Lines.process';

async function until(check: () => boolean | Promise<boolean>, max = 3000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** Counts every store call by method, and lets a test make one method fail. */
function instrumented(inner: StateStore = new InMemoryStateStore()) {
  const calls = new Map<string, number>();
  const failing = new Map<string, (args: unknown[]) => boolean>();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        if (failing.get(String(prop))?.(args)) {
          return Promise.reject(new Error(`store down: ${String(prop)}`));
        }
        return value.apply(target, args);
      };
    },
  });
  return { store, calls, failing };
}

/** Records dispatches; the test delivers the results, as a broker's results consumer would. */
class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  handler?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(): void {}
  deliver(result: StepResult): Promise<void> {
    if (!this.handler) throw new Error('no result handler');
    return this.handler(result);
  }
}

const ok = (t: RemoteTask): StepResult => ({
  runId: t.runId,
  seq: t.seq,
  stepId: t.stepId,
  status: 'completed',
  output: (t.input as { i: number }).i * 10,
});

describe('a child completion lost between the child and its parent', () => {
  it("is delivered by the parent's next turn, from one batched read of its children", async () => {
    const { store, calls, failing } = instrumented();
    let now = Date.now();
    const engine = new WorkflowEngine({ store, clock: () => now });
    const n = 60;
    engine.register('child', '1', async (ctx, input) => (input as { i: number }).i * 2);
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>(
        'child',
        Array.from({ length: n }, (_, i) => ({ i })),
      ),
    );
    // Every child's notification of its parent fails, as when the instance that ran it goes down
    // right after persisting the child `completed`.
    failing.set('takeSignalWaiter', ([token]) => String(token).startsWith('child:p.all.'));

    await engine.start('parent', {}, 'p');
    await until(async () => {
      const runs = await store.listRuns({ workflow: 'child', status: 'completed' });
      return runs.length === n;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.getRun('p'))?.status).toBe('suspended');
    expect(await store.listSignalWaiters('child:p.all.')).toHaveLength(n);

    // The store is back; the parent's reconcile wake comes due.
    failing.clear();
    calls.clear();
    now += 301_000;
    await engine.resumeDueTimers(now);
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(Array.from({ length: n }, (_, i) => i * 2));
    expect(await store.listSignalWaiters('child:p.all.')).toHaveLength(0);
    // One batched read of the children, not one per child.
    expect(calls.get('getRuns')).toBe(1);
    expect(calls.get('getRun') ?? 0).toBeLessThan(10);
  });

  it('delivers a failed child as a failure', async () => {
    const { store, failing } = instrumented();
    let now = Date.now();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('child', '1', async (_ctx, input) => {
      if ((input as { i: number }).i === 1) throw new Error('bad line');
      return 'ok';
    });
    engine.register('parent', '1', async (ctx) => {
      const settled = await ctx.allSettled('child', [{ i: 0 }, { i: 1 }]);
      return settled.map((s) => s.status);
    });
    failing.set('takeSignalWaiter', ([token]) => String(token).startsWith('child:p.all.'));
    await engine.start('parent', {}, 'p');
    await until(async () => {
      const done = await store.listRuns({ workflow: 'child', statuses: ['completed', 'failed'] });
      return done.length === 2;
    });
    failing.clear();
    now += 301_000;
    await engine.resumeDueTimers(now);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(['fulfilled', 'rejected']);
  });

  it("is delivered to a remote workflow's next turn, from its child waiters", async () => {
    const { store, failing } = instrumented();
    let now = Date.now();
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      clock: () => now,
    });
    engine.registerRemote('child', '1', {
      group: 'py',
      executor: {
        async advance(run: WorkflowRun): Promise<WorkflowDecision> {
          const output = (run.input as number) * 3;
          return { taskId: 't', runId: run.id, status: 'completed', commands: [], output };
        },
      },
    });
    engine.registerRemote('parent', '1', {
      group: 'py',
      executor: {
        async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
          const base = { taskId: 't', runId: run.id } as const;
          if (history.length === 0) {
            const commands = [0, 1, 2].map((seq) => ({
              kind: 'startChild' as const,
              seq,
              workflow: 'child',
              input: seq,
              parallelGroup: 'gather:0',
            }));
            return { ...base, status: 'continue', commands };
          }
          if (history.length === 3) {
            const output = history.map((e) => e.output);
            return { ...base, status: 'completed', commands: [], output };
          }
          return { ...base, status: 'continue', commands: [] };
        },
      },
    });
    failing.set('takeSignalWaiter', ([token]) => String(token).startsWith('child:p.child.'));
    await engine.start('parent', {}, 'p');
    await until(async () => {
      const done = await store.listRuns({ workflow: 'child', status: 'completed' });
      return done.length === 3;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.getRun('p'))?.status).toBe('suspended');

    failing.clear();
    now += 301_000;
    await engine.resumeDueTimers(now);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([0, 3, 6]);
    expect(await store.listSignalWaiters('child:p.child.')).toHaveLength(0);
  });

  it('a notification that fails on a transient store error is retried', async () => {
    const { store, failing } = instrumented();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async () => 'done');
    engine.register('parent', '1', async (ctx) => ctx.child<string>('child', {}, 'kid'));
    let failures = 0;
    failing.set('takeSignalWaiter', ([token]) => token === 'child:kid' && ++failures <= 1);

    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toBe('done');
    expect(failures).toBeGreaterThan(1);
  });
});

describe('a step result whose resume was lost', () => {
  function oneStepChild(opts: Partial<ConstructorParameters<typeof WorkflowEngine>[0]> = {}) {
    const store = new InMemoryStateStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0, ...opts });
    engine.register('line', '1', async (ctx, input) => ctx.step<number>(LINE, input));
    return { store, transport, engine };
  }

  it('resumes the run when the result is redelivered after its step settled', async () => {
    const { store, transport, engine } = oneStepChild();
    await startRun(engine, 'line', { i: 4 }, 'c');
    const [task] = transport.dispatched as [RemoteTask];
    // The instance that settles the result cannot resume the run: another one holds its lease.
    await store.tryLockRun('c', 'gone-pod', Date.now() + 60_000, Date.now());
    await transport.deliver(ok(task));
    expect((await store.getCheckpoint('c', 0))?.status).toBe('completed');
    expect((await store.getRun('c'))?.status).toBe('suspended');

    // The lease is released (or lapses) and the transport redelivers the result.
    await store.releaseRunLock('c');
    await transport.deliver(ok(task));
    await until(async () => (await store.getRun('c'))?.status === 'completed');
    expect((await store.getRun('c'))?.output).toBe(40);
  });

  it('resumes the run once the lease of an instance that went down lapses', async () => {
    const { store, transport, engine } = oneStepChild();
    await startRun(engine, 'line', { i: 7 }, 'c');
    const [task] = transport.dispatched as [RemoteTask];
    // The turn's instance went down holding the lease, with the run already written `suspended`.
    await store.tryLockRun('c', 'gone-pod', Date.now() + 150, Date.now());
    await transport.deliver(ok(task));
    expect((await store.getRun('c'))?.status).toBe('suspended');

    await until(async () => (await store.getRun('c'))?.status === 'completed');
    expect((await store.getRun('c'))?.output).toBe(70);
  });

  it('parks a run waiting on a dispatched step no later than reconcileMs, even with a long redispatch deadline', async () => {
    const store = new InMemoryStateStore();
    const transport = new HeldTransport();
    const now = Date.now();
    const engine = new WorkflowEngine({
      store,
      transport,
      clock: () => now,
      reconcileMs: 300_000,
      remoteRedispatchMs: 3_600_000,
    });
    engine.register('line', '1', async (ctx, input) => ctx.step<number>(LINE, input));
    await startRun(engine, 'line', { i: 1 }, 'c');
    // The replay that stamps the redispatch deadline.
    await engine.resume('c');
    const run = await store.getRun('c');
    expect(run?.status).toBe('suspended');
    expect(run?.wakeAt).toBeLessThanOrEqual(now + 300_000);
    // The step's own deadline is unchanged.
    expect((await store.getCheckpoint('c', 0))?.wakeAt).toBe(now + 3_600_000);
  });
});

describe('the instance hosting a wide fan', () => {
  it('runs one turn of the parent when many children settle at once', async () => {
    // A store behind a connection pool, like a database. The children's notifications queue up, so
    // the waiter takes of a whole chunk of them land before their barrier checks, every one of
    // those sees the fan's last waiter gone, and their wakes of the parent arrive one after another
    // while the first wake's turn holds the lease on this same instance.
    const inner = new InMemoryStateStore();
    let busy = 0;
    const queued: (() => void)[] = [];
    const acquire = (): Promise<void> => {
      if (busy < 20) {
        busy += 1;
        return Promise.resolve();
      }
      return new Promise<void>((r) => queued.push(r));
    };
    const release = () => {
      const next = queued.shift();
      if (next) next();
      else busy -= 1;
    };
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await acquire();
          try {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return await value.apply(target, args);
          } finally {
            release();
          }
        };
      },
    });
    const transport = new InMemoryTransport();
    transport.handle(LINE, async (input: { i: number }) => input.i);
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    const n = 1200;
    let parentTurns = 0;
    engine.register('child', '1', async (ctx, input) => ctx.step<number>(LINE, input));
    engine.register('parent', '1', async (ctx) => {
      parentTurns += 1;
      return ctx.all<number>(
        'child',
        Array.from({ length: n }, (_, i) => ({ i })),
      );
    });
    await engine.start('parent', {}, 'p');
    await until(async () => (await inner.getRun('p'))?.status === 'completed', 30_000);
    expect((await inner.getRun('p'))?.output).toEqual(Array.from({ length: n }, (_, i) => i));
    // The dispatching turn, the one the fan's last child wakes, and at most one more.
    expect(parentTurns).toBeLessThanOrEqual(3);
  }, 60_000);

  it('executes at most 256 runs of its own at once, with no option to set', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    let active = 0;
    let peak = 0;
    engine.register('child', '1', async (ctx) =>
      ctx.localStep('work', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return 1;
      }),
    );
    engine.register(
      'parent',
      '1',
      async (ctx) =>
        (
          await ctx.all<number>(
            'child',
            Array.from({ length: 600 }, () => ({})),
          )
        ).length,
    );
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed', 10_000);
    expect((await store.getRun('p'))?.output).toBe(600);
    expect(peak).toBeLessThanOrEqual(256);
    expect(peak).toBeGreaterThan(100);
  });

  it('runEnqueued skips a run another instance already took', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    let turns = 0;
    engine.register('wf', '1', async (ctx) => {
      turns += 1;
      await ctx.waitForSignal('later');
    });
    await startRun(engine, 'wf', {}, 'r');
    expect(turns).toBe(1);
    engine.runEnqueued('r');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns).toBe(1);
  });
});
