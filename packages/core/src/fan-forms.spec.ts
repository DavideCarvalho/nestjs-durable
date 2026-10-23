import { describe, expect, it } from 'vitest';
import { isWorkflowControlFlowSignal } from './control-flow-signal';
import { WorkflowEngine } from './engine';
import { GatherError } from './errors';
import type {
  RemoteTask,
  RunDispatch,
  RunQueueOptions,
  Settled,
  StateStore,
  StepResult,
  Transport,
  WorkflowCtx,
} from './interfaces';
import { DURABLE_STEP_NAME, type StepRef } from './step-name-symbol';
import { InMemoryRunQueue } from './testing/in-memory-run-queue';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/**
 * The wide-fan guarantees hold for every fan form: `ctx.all` and `ctx.allSettled`, over child
 * workflows and over a `@Step`, with and without `concurrency`. `allSettled` reports a failed,
 * cancelled or dead child as a rejected entry and never fails the fan; `all` fails it.
 */

async function until(check: () => boolean | Promise<boolean>, max = 10_000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts store calls by method, and lets a test make one fail or hold. */
function instrumented(inner: InMemoryStateStore = new InMemoryStateStore()) {
  const calls = new Map<string, number>();
  const failing = new Map<string, (args: unknown[]) => boolean>();
  const holding = new Map<string, (args: unknown[]) => Promise<void> | undefined>();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        await holding.get(String(prop))?.(args);
        if (failing.get(String(prop))?.(args)) throw new Error(`store down: ${String(prop)}`);
        return value.apply(target, args);
      };
    },
  }) as InMemoryStateStore;
  return { store, inner, calls, failing, holding };
}

interface Form {
  name: string;
  settle: boolean;
  concurrency?: number;
}

const FORMS: Form[] = [
  { name: 'ctx.all', settle: false },
  { name: 'ctx.all with concurrency', settle: false, concurrency: 2 },
  { name: 'ctx.allSettled', settle: true },
  { name: 'ctx.allSettled with concurrency', settle: true, concurrency: 2 },
];

/** Run the fan of `form` over `ref` (a child workflow name or a step). */
function fanOf(
  ctx: WorkflowCtx,
  form: Form,
  ref: string | StepRef<unknown, unknown>,
  inputs: unknown[],
): Promise<unknown[]> {
  const opts = form.concurrency ? { concurrency: form.concurrency } : undefined;
  return form.settle
    ? (ctx.allSettled as (r: unknown, i: unknown[], o?: unknown) => Promise<unknown[]>)(
        ref,
        inputs,
        opts,
      )
    : (ctx.all as (r: unknown, i: unknown[], o?: unknown) => Promise<unknown[]>)(ref, inputs, opts);
}

/** The same form with a `concurrency` sized for a wide fan (a few dozen waves, not hundreds). */
const wide = (form: Form): Form => (form.concurrency ? { ...form, concurrency: 64 } : form);

/** What a fan whose every item succeeded with `values` returns, per form. */
const fulfilled = (form: Form, values: unknown[]) =>
  form.settle ? values.map((value) => ({ status: 'fulfilled', value })) : values;

function stepRef(name: string): StepRef<unknown, unknown> {
  const ref = (() => {}) as unknown as StepRef<unknown, unknown>;
  (ref as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = name;
  return ref;
}

const LINE = 'Lines.process';

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

/** The id of the fan child started with input `{ i }` (its id carries the wave under `concurrency`). */
async function childOf(store: StateStore, i: number): Promise<string> {
  let id: string | undefined;
  await until(async () => {
    const runs = await store.listRuns({ workflow: 'child' });
    id = runs.find((r) => (r.input as { i?: number }).i === i)?.id;
    return id !== undefined;
  });
  return id as string;
}

/** Advance past the parent's reconcile wake until `check`, as the timer poll would. */
async function reconcileUntil(
  engine: WorkflowEngine,
  clock: { now: number },
  check: () => Promise<boolean>,
): Promise<number> {
  let polls = 0;
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return polls;
    clock.now += 301_000;
    polls += 1;
    await engine.resumeDueTimers(clock.now);
    await pause(5);
  }
  throw new Error('never settled');
}

describe.each(FORMS)('$name over child workflows', (form) => {
  it('a lost completion is delivered by the next reconcile, from one batched read', async () => {
    const { store, calls, failing } = instrumented();
    const clock = { now: Date.now() };
    const engine = new WorkflowEngine({ store, clock: () => clock.now });
    const n = 40;
    engine.register('child', '1', async (_ctx, input) => (input as { i: number }).i * 2);
    engine.register('parent', '1', async (ctx) =>
      fanOf(
        ctx,
        form,
        'child',
        Array.from({ length: n }, (_, i) => ({ i })),
      ),
    );
    failing.set('takeSignalWaiter', ([token]) => String(token).startsWith('child:p.all.'));
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.listRuns({ workflow: 'child' })).length > 0);
    await pause(30);
    failing.clear();
    calls.clear();
    // A wave at a time under `concurrency`: each wave's completions are lost, each reconcile finds
    // them. One batched read per wave, never one per child.
    const notify = failing;
    notify.set('takeSignalWaiter', ([token]) => String(token).startsWith('child:p.all.'));
    const polls = await reconcileUntil(
      engine,
      clock,
      async () => (await store.getRun('p'))?.status === 'completed',
    );
    expect((await store.getRun('p'))?.output).toEqual(
      fulfilled(
        form,
        Array.from({ length: n }, (_, i) => i * 2),
      ),
    );
    expect(await store.listSignalWaiters('child:p.all.')).toHaveLength(0);
    expect(calls.get('getRuns') ?? 0).toBeGreaterThanOrEqual(1);
    expect(calls.get('getRuns') ?? 0).toBeLessThanOrEqual(polls * 2);
  });

  for (const ending of ['failed', 'cancelled', 'dead'] as const) {
    it(`a ${ending} child ${form.settle ? 'settles as a rejected entry' : 'fails the fan'}`, async () => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store, reconcileMs: 0, maxRecoveryAttempts: 1 });
      engine.register('child', '1', async (ctx, input) => {
        const { i } = input as { i: number };
        if (i === 1 && ending === 'failed') throw new Error('bad line');
        if (i === 1) await ctx.waitForSignal('never');
        return i;
      });
      engine.register('parent', '1', async (ctx) => {
        try {
          return await fanOf(ctx, form, 'child', [{ i: 0 }, { i: 1 }, { i: 2 }]);
        } catch (err) {
          if (isWorkflowControlFlowSignal(err)) throw err;
          return { threw: (err as Error).name };
        }
      });
      await engine.start('parent', {}, 'p');
      const child = await childOf(store, 1);
      if (ending !== 'failed') {
        await until(async () => (await store.getRun(child))?.status === 'suspended');
        if (ending === 'cancelled') await engine.cancel(child);
        else {
          // Its instance kept crashing mid-turn: recovery gives up on it.
          await store.updateRun(child, {
            status: 'running',
            lockedBy: 'gone',
            lockedUntil: Date.now() - 1,
            recoveryAttempts: 1,
          });
          await engine.recoverIncomplete();
        }
      }
      // Delivered by the child itself: no reconcile wake (reconcileMs: 0) and no poll.
      await until(async () => (await store.getRun('p'))?.status === 'completed');
      const output = (await store.getRun('p'))?.output as Settled<number>[] | { threw: string };
      if (form.settle) {
        const settled = output as Settled<number>[];
        expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
        const rejected = settled[1] as Extract<Settled<number>, { status: 'rejected' }>;
        if (ending === 'cancelled') expect(rejected.code).toBe('cancelled');
      } else {
        expect(output).toEqual({ threw: GatherError.name });
      }
    });

    it(`a ${ending} child whose notification was lost is reconciled ${form.settle ? 'as rejected' : 'as a failure'}`, async () => {
      const { store, inner, failing } = instrumented();
      const clock = { now: Date.now() };
      const engine = new WorkflowEngine({ store, clock: () => clock.now });
      engine.register('child', '1', async (ctx, input) => {
        const { i } = input as { i: number };
        if (i === 1) await ctx.waitForSignal('never');
        return i;
      });
      engine.register('parent', '1', async (ctx) => {
        try {
          return await fanOf(ctx, form, 'child', [{ i: 0 }, { i: 1 }]);
        } catch (err) {
          if (isWorkflowControlFlowSignal(err)) throw err;
          return { threw: (err as Error).name };
        }
      });
      failing.set('takeSignalWaiter', ([token]) => String(token).startsWith('child:p.all.'));
      await engine.start('parent', {}, 'p');
      const child = await childOf(store, 1);
      await until(async () => (await store.getRun(child))?.status === 'suspended');
      // It ended where no notification of it reached the parent (another instance, now gone).
      await inner.updateRun(child, { status: ending, error: { message: ending } });
      await reconcileUntil(
        engine,
        clock,
        async () => (await store.getRun('p'))?.status === 'completed',
      );
      const output = (await store.getRun('p'))?.output;
      if (form.settle) {
        expect((output as Settled<number>[]).map((s) => s.status)).toEqual([
          'fulfilled',
          'rejected',
        ]);
      } else {
        expect(output).toEqual({ threw: GatherError.name });
      }
    });
  }

  it('a late notification after the reconcile leaves no buffered completion behind', async () => {
    const { store, inner, holding } = instrumented();
    const clock = { now: Date.now() };
    const engine = new WorkflowEngine({ store, clock: () => clock.now });
    engine.register('child', '1', async () => 'done');
    engine.register('parent', '1', async (ctx) => fanOf(ctx, form, 'child', [{}]));
    // The child's notification is slow: it reaches the store only after the parent reconciled.
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    holding.set('takeSignalWaiter', ([token]) =>
      String(token).startsWith('child:p.all.') ? late : undefined,
    );
    await engine.start('parent', {}, 'p');
    await until(
      async () => (await store.listRuns({ workflow: 'child', status: 'completed' })).length === 1,
    );
    holding.clear();
    await reconcileUntil(
      engine,
      clock,
      async () => (await store.getRun('p'))?.status === 'completed',
    );
    release();
    await engine.drain(2_000);
    const childId = (await store.listRuns({ workflow: 'child' }))[0]?.id as string;
    expect(await inner.takeBufferedSignal(`child:${childId}`)).toBeFalsy();
  });

  it('queues its children on the run queue in batches and splits them across instances', async () => {
    const big = wide(form);
    const store = new InMemoryStateStore();
    const queue = new InMemoryRunQueue();
    const batches: RunDispatch[][] = [];
    const recordedTransport = (): Transport => {
      const inner = queue.transport();
      return {
        ...inner,
        dispatchRuns: async (runs: RunDispatch[], opts?: RunQueueOptions) => {
          batches.push(runs);
          await inner.dispatchRuns?.(runs, opts);
        },
      };
    };
    const ran = new Map<number, string[]>();
    const n = 600;
    const engines = [0, 1].map((k) => {
      const engine = new WorkflowEngine({ store, transport: recordedTransport(), reconcileMs: 0 });
      engine.register('child', '1', async (ctx, input) =>
        ctx.localStep('work', async () => {
          const { i } = input as { i: number };
          ran.set(i, [...(ran.get(i) ?? []), `e${k}`]);
          await pause(2);
          return i;
        }),
      );
      engine.register('parent', '1', async (ctx) =>
        fanOf(
          ctx,
          big,
          'child',
          Array.from({ length: n }, (_, i) => ({ i })),
        ),
      );
      engine.consumeRuns();
      return engine;
    });
    await engines[0]?.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed', 20_000);
    expect((await store.getRun('p'))?.output).toEqual(
      fulfilled(
        big,
        Array.from({ length: n }, (_, i) => i),
      ),
    );
    expect(ran.size).toBe(n);
    for (const by of ran.values()) expect(by).toHaveLength(1);
    expect([...ran.values()].some(([by]) => by === 'e1')).toBe(true);
    expect([...ran.values()].some(([by]) => by === 'e0')).toBe(true);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(500);
    // Batched: far fewer writes than children (a wave of 4 under `concurrency: 8` is one write).
    expect(batches.length).toBeLessThan(big.concurrency ? n / 3 : n / 20);
  }, 30_000);

  it('executes at most 256 children at once on the instance running the parent', async () => {
    const big = wide(form);
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    let active = 0;
    let peak = 0;
    engine.register('child', '1', async (ctx) =>
      ctx.localStep('work', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await pause(2);
        active -= 1;
        return 1;
      }),
    );
    engine.register(
      'parent',
      '1',
      async (ctx) =>
        (
          await fanOf(
            ctx,
            big,
            'child',
            Array.from({ length: 600 }, () => ({})),
          )
        ).length,
    );
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'completed', 20_000);
    expect((await store.getRun('p'))?.output).toBe(600);
    expect(peak).toBeLessThanOrEqual(big.concurrency ?? 256);
  }, 30_000);

  it('runs one turn of the parent per settled wave when many children settle at once', async () => {
    const big = wide(form);
    const inner = new InMemoryStateStore();
    const store = pooled(inner);
    const transport = new InMemoryTransport();
    transport.handle(LINE, async (input: { i: number }) => input.i);
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    const n = big.concurrency ? 64 : 600;
    let turns = 0;
    engine.register('child', '1', async (ctx, input) => ctx.step<number>(LINE, input));
    engine.register('parent', '1', async (ctx) => {
      turns += 1;
      return fanOf(
        ctx,
        big,
        'child',
        Array.from({ length: n }, (_, i) => ({ i })),
      );
    });
    await engine.start('parent', {}, 'p');
    await until(async () => (await inner.getRun('p'))?.status === 'completed', 30_000);
    expect((await inner.getRun('p'))?.output).toEqual(
      fulfilled(
        big,
        Array.from({ length: n }, (_, i) => i),
      ),
    );
    // One dispatching turn, one per settled wave, and at most one shared extra turn per wave.
    const waves = big.concurrency ? Math.ceil(n / Math.floor(big.concurrency / 2)) : 1;
    expect(turns).toBeLessThanOrEqual(1 + waves * 2);
  }, 60_000);

  it('after the instance running the parent went down, the next reconcile delivers the children that finished', async () => {
    const store = new InMemoryStateStore();
    const clock = { now: Date.now() };
    const doomed = new WorkflowEngine({ store, clock: () => clock.now });
    const n = 12;
    const register = (engine: WorkflowEngine) => {
      engine.register('child', '1', async (ctx, input) => {
        await ctx.waitForSignal(`go:${(input as { i: number }).i}`);
        return (input as { i: number }).i;
      });
      engine.register('parent', '1', async (ctx) =>
        fanOf(
          ctx,
          form,
          'child',
          Array.from({ length: n }, (_, i) => ({ i })),
        ),
      );
    };
    register(doomed);
    await doomed.start('parent', {}, 'p');
    await until(
      async () => (await store.listRuns({ workflow: 'child', status: 'suspended' })).length > 0,
    );
    // The parent's instance goes down for good, and every waiting child finishes somewhere whose
    // notification never reaches the parent (written straight to the store).
    await doomed.drain(1_000);
    for (const child of await store.listRuns({ workflow: 'child' })) {
      await store.updateRun(child.id, {
        status: 'completed',
        output: (child.input as { i: number }).i,
      });
    }
    // A surviving instance's poll, no later than reconcileMs after the parent parked.
    const survivor = new WorkflowEngine({ store, clock: () => clock.now });
    register(survivor);
    const parked = await store.getRun('p');
    expect(parked?.wakeAt).toBeLessThanOrEqual(clock.now + 300_000);
    // Under `concurrency` each wave costs one more reconcile; without, one.
    for (let i = 0; i < 20 && (await store.getRun('p'))?.status !== 'completed'; i += 1) {
      clock.now += 300_000;
      await survivor.resumeDueTimers(clock.now);
      await pause(10);
      for (const child of await store.listRuns({ workflow: 'child', status: 'suspended' })) {
        await store.updateRun(child.id, {
          status: 'completed',
          output: (child.input as { i: number }).i,
        });
      }
    }
    expect((await store.getRun('p'))?.output).toEqual(
      fulfilled(
        form,
        Array.from({ length: n }, (_, i) => i),
      ),
    );
  });
});

/** A store behind a 20-connection pool with a 1ms round trip, like a database. */
function pooled(inner: StateStore): StateStore {
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
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await acquire();
        try {
          await pause(1);
          return await value.apply(target, args);
        } finally {
          release();
        }
      };
    },
  });
}

describe.each(FORMS)('$name over a step', (form) => {
  const line = stepRef(LINE);

  function setup() {
    const store = new InMemoryStateStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    let turns = 0;
    engine.register('fan', '1', async (ctx) => {
      turns += 1;
      try {
        return await fanOf(
          ctx,
          form,
          line,
          Array.from({ length: 6 }, (_, i) => ({ i })),
        );
      } catch (err) {
        if (isWorkflowControlFlowSignal(err)) throw err;
        return { threw: (err as Error).name };
      }
    });
    return { store, transport, engine, turns: () => turns };
  }

  /** Deliver every dispatched result until the fan stops dispatching. */
  async function settleAll(transport: HeldTransport, fail?: (t: RemoteTask) => boolean) {
    const delivered = new Set<string>();
    for (let round = 0; round < 50; round += 1) {
      const fresh = transport.dispatched.filter((t) => !delivered.has(t.stepId));
      if (fresh.length === 0) {
        await pause(5);
        if (transport.dispatched.every((t) => delivered.has(t.stepId))) return;
        continue;
      }
      for (const t of fresh) {
        delivered.add(t.stepId);
        await transport.deliver(
          fail?.(t)
            ? {
                runId: t.runId,
                seq: t.seq,
                stepId: t.stepId,
                status: 'failed',
                error: { message: 'bad line' },
              }
            : ok(t),
        );
      }
      await pause(5);
    }
  }

  it('completes with every result', async () => {
    const { store, transport, engine } = setup();
    await engine.start('fan', {}, 'f');
    await until(() => transport.dispatched.length > 0);
    await settleAll(transport);
    await until(async () => (await store.getRun('f'))?.status === 'completed');
    expect((await store.getRun('f'))?.output).toEqual(
      fulfilled(
        form,
        Array.from({ length: 6 }, (_, i) => i * 10),
      ),
    );
  });

  it(`a failed step ${form.settle ? 'settles as a rejected entry' : 'fails the fan'}`, async () => {
    const { store, transport, engine } = setup();
    await engine.start('fan', {}, 'f');
    await until(() => transport.dispatched.length > 0);
    await settleAll(transport, (t) => (t.input as { i: number }).i === 2);
    await until(async () => (await store.getRun('f'))?.status === 'completed');
    const output = (await store.getRun('f'))?.output;
    if (form.settle) {
      expect((output as Settled<number>[]).map((s) => s.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'rejected',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
    } else {
      expect(output).toEqual({ threw: GatherError.name });
    }
  });

  it("resumes the fan when its last result is redelivered after the first one's resume was lost", async () => {
    const { store, transport, engine } = setup();
    await engine.start('fan', {}, 'f');
    await until(() => transport.dispatched.length > 0);
    const delivered = new Set<string>();
    // Every result of the wave lands while another instance holds the run's lease: settled, but
    // the resume is dropped.
    const deliverWave = async () => {
      await store.tryLockRun('f', 'gone-pod', Date.now() + 60_000, Date.now());
      const wave = transport.dispatched.filter((t) => !delivered.has(t.stepId));
      for (const t of wave) {
        delivered.add(t.stepId);
        await transport.deliver(ok(t));
      }
      expect((await store.getRun('f'))?.status).toBe('suspended');
      await store.releaseRunLock('f');
      // The broker redelivers the wave's last result.
      await transport.deliver(ok(wave[wave.length - 1] as RemoteTask));
    };
    for (let i = 0; i < 20 && (await store.getRun('f'))?.status !== 'completed'; i += 1) {
      await until(
        async () =>
          (await store.getRun('f'))?.status === 'completed' ||
          transport.dispatched.some((t) => !delivered.has(t.stepId)),
      );
      if ((await store.getRun('f'))?.status === 'completed') break;
      await deliverWave();
      await pause(10);
    }
    await until(async () => (await store.getRun('f'))?.status === 'completed');
    expect((await store.getRun('f'))?.output).toEqual(
      fulfilled(
        form,
        Array.from({ length: 6 }, (_, i) => i * 10),
      ),
    );
  });

  it('runs one shared turn after many results land together', async () => {
    const { store, transport, engine, turns } = setup();
    await engine.start('fan', {}, 'f');
    await until(() => transport.dispatched.length > 0);
    const delivered = new Set<string>();
    for (
      let round = 0;
      round < 20 && (await store.getRun('f'))?.status !== 'completed';
      round += 1
    ) {
      const wave = transport.dispatched.filter((t) => !delivered.has(t.stepId));
      for (const t of wave) delivered.add(t.stepId);
      // All of the wave's results at once, as a results consumer with concurrency would.
      await Promise.all(wave.map((t) => transport.deliver(ok(t))));
      await pause(10);
    }
    await until(async () => (await store.getRun('f'))?.status === 'completed');
    const waves = form.concurrency ? Math.ceil(6 / form.concurrency) : 1;
    expect(turns()).toBeLessThanOrEqual(1 + waves * 2);
  });
});

describe('ctx.all failFast with cancelled siblings', () => {
  it('replays to the failure that failed it, not to a sibling it cancelled', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (ctx, input) => {
      const { i } = input as { i: number };
      if (i === 2) throw new Error('bad line');
      await ctx.waitForSignal('never');
      return i;
    });
    engine.register('parent', '1', async (ctx) => {
      let failed: number | undefined;
      try {
        await ctx.all('child', [{ i: 0 }, { i: 1 }, { i: 2 }], { mode: 'failFast' });
      } catch (err) {
        if (isWorkflowControlFlowSignal(err)) throw err;
        failed = (err as GatherError).failures[0]?.index;
      }
      await ctx.waitForSignal('later');
      return failed;
    });
    await engine.start('parent', {}, 'p');
    // The siblings are cancelled by the fan, and report themselves cancelled to the parent.
    await until(async () => {
      const cancelled = await store.listRuns({ workflow: 'child', status: 'cancelled' });
      return cancelled.length === 2;
    });
    await pause(30);
    await engine.signal('later', undefined);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toBe(2);
  });

  it('a cancelled lone child fails ctx.child in its parent', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (ctx) => ctx.waitForSignal('never'));
    engine.register('parent', '1', async (ctx) => {
      try {
        await ctx.child('child', {}, 'kid');
        return 'finished';
      } catch (err) {
        if (isWorkflowControlFlowSignal(err)) throw err;
        return (err as Error).message;
      }
    });
    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('kid'))?.status === 'suspended');
    await engine.cancel('kid');
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toContain('cancelled');
  });

  it('a parent cancelled first is not written to by the children it cancels', async () => {
    const { store, calls } = instrumented();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (ctx) => ctx.waitForSignal('never'));
    engine.register('parent', '1', async (ctx) =>
      ctx.all(
        'child',
        Array.from({ length: 20 }, () => ({})),
      ),
    );
    await engine.start('parent', {}, 'p');
    await until(
      async () => (await store.listRuns({ workflow: 'child', status: 'suspended' })).length === 20,
    );
    calls.clear();
    await engine.cancel('p');
    await until(
      async () => (await store.listRuns({ workflow: 'child', status: 'cancelled' })).length === 20,
    );
    await engine.drain(2_000);
    expect((await store.getRun('p'))?.status).toBe('cancelled');
    expect(calls.get('saveCheckpoint') ?? 0).toBe(0);
  });
});
