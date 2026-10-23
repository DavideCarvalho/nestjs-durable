import {
  InMemoryStateStore,
  type RunConsumerOptions,
  type RunDispatch,
  type RunQueueOptions,
  type StateStore,
  type Transport,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';

/**
 * Two transports on one broker (two instances of one deployment), isolated from every other case:
 * a fresh prefix, table or queue per call. Both carry a run queue
 * ({@link Transport.dispatchRuns} + {@link Transport.onDispatchedRun}).
 */
export interface RunDispatchHarness {
  pair(): Promise<[Transport, Transport]>;
}

/**
 * Builds the harness once per case, or returns a string: the reason the backend is unavailable
 * (no Docker, say), which skips the case.
 */
export type RunDispatchHarnessFactory = () => Promise<RunDispatchHarness | string>;

export interface RunDispatchContractOptions {
  /** Per-case budget; a polling transport needs more. Default 30s. */
  timeoutMs?: number;
  /** Children in the fan cases. Default 300. */
  fanSize?: number;
  /**
   * Whether a run already waiting in the queue is not queued a second time. Default true. False for
   * an at-least-once queue without deduplication (an SQS standard queue): the contract then checks
   * that a run received twice still runs one turn.
   */
  dedupesWaitingRuns?: boolean;
}

/** A transport whose `dispatchRuns` is recorded, and can be made to fail. */
interface Recorded {
  transport: Transport;
  batches: RunDispatch[][];
  failing: { on: boolean };
}

function recorded(inner: Transport): Recorded {
  const batches: RunDispatch[][] = [];
  const failing = { on: false };
  const transport = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'dispatchRuns') {
        return async (runs: RunDispatch[], opts?: RunQueueOptions) => {
          if (failing.on) throw new Error('broker down');
          batches.push(runs);
          return target.dispatchRuns?.(runs, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { transport, batches, failing };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fan forms every fan case runs for. */
const FANS = [
  { fan: 'ctx.all fan', settle: false },
  { fan: 'ctx.allSettled fan', settle: true },
];

interface Instance {
  name: string;
  engine: WorkflowEngine;
}

/** An engine per transport, on one shared store, each consuming the run queue. */
function instances(store: StateStore, transports: Transport[], clock?: () => number): Instance[] {
  return transports.map((transport, i) => {
    const engine = new WorkflowEngine({
      store,
      transport,
      reconcileMs: 0,
      ...(clock ? { clock } : {}),
    });
    return { name: `instance-${i}`, engine };
  });
}

/**
 * Register a fan of `fanSize` children on every instance; each child records who executed it.
 *
 * With `spreadWithinMs`, a child holds its slot until every instance has started one (or the time is
 * up). Both instances live in one process, so which consumer claims first is down to scheduling, and
 * an instance that keeps finding rows can drain the whole fan while its sibling sleeps between polls.
 * An instance runs at most 256 runs at once and the fan is bigger, so while its children wait the
 * rest of the fan can only go to the other instance: the split no longer depends on timing.
 */
function registerFan(
  all: Instance[],
  fanSize: number,
  ran: Map<number, string[]>,
  settle: boolean,
  spreadWithinMs?: number,
): void {
  const executors = () => new Set([...ran.values()].map(([first]) => first));
  for (const { name, engine } of all) {
    engine.register('child', '1', async (ctx, input) => {
      const { i } = input as { i: number };
      return ctx.localStep('work', async () => {
        ran.set(i, [...(ran.get(i) ?? []), name]);
        if (spreadWithinMs !== undefined) {
          await until(() => executors().size >= all.length, spreadWithinMs).catch(() => undefined);
        }
        await pause(15);
        return i * 2;
      });
    });
    engine.register('parent', '1', async (ctx) => {
      const inputs = Array.from({ length: fanSize }, (_, i) => ({ i }));
      return settle ? ctx.allSettled<number>('child', inputs) : ctx.all<number>('child', inputs);
    });
  }
}

/** What the fan returns when every child doubled its index, for `ctx.all` or `ctx.allSettled`. */
function doubled(fanSize: number, settle: boolean): unknown[] {
  const values = Array.from({ length: fanSize }, (_, i) => i * 2);
  return settle ? values.map((value) => ({ status: 'fulfilled', value })) : values;
}

/**
 * A store holding one write of run `p` until released: its turn's suspension (the wake then lands
 * while the turn still holds the lease), or the `running` placeholder of an awaited child.
 */
function holdingTurn(
  inner: InMemoryStateStore,
  hold: 'suspend' | 'placeholder',
): {
  store: StateStore;
  state: { held: boolean; release: () => void };
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { held: false, release: () => release() };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      const holds = (args: unknown[]): boolean => {
        if (state.held) return false;
        if (hold === 'suspend' && (prop === 'updateRun' || prop === 'updateRunIf')) {
          const patch = (prop === 'updateRun' ? args[1] : args[2]) as { status?: string };
          return args[0] === 'p' && patch.status === 'suspended';
        }
        if (hold === 'placeholder' && prop === 'saveCheckpoint') {
          const cp = args[0] as { runId: string; status: string; name: string };
          return cp.runId === 'p' && cp.status === 'running' && cp.name.startsWith('signal:child:');
        }
        return false;
      };
      return async (...args: unknown[]) => {
        if (holds(args)) {
          state.held = true;
          await gate;
        }
        return fn.apply(target, args);
      };
    },
  }) as StateStore;
  return { store, state };
}

/** The ways a parent waits on something another instance finishes while its turn still runs. */
const MID_TURN = [
  {
    what: "ctx.child's completion",
    body: (ctx: WorkflowCtx) => ctx.child('child', {}),
    output: 'done' as unknown,
    signal: false,
  },
  {
    what: "ctx.child's completion, raced against its timeline placeholder",
    body: (ctx: WorkflowCtx) => ctx.child('child', {}),
    output: 'done' as unknown,
    signal: false,
    hold: 'placeholder' as const,
  },
  {
    what: "a ctx.all fan's completions",
    body: (ctx: WorkflowCtx) => ctx.all('child', [{}, {}, {}]),
    output: ['done', 'done', 'done'] as unknown,
    signal: false,
  },
  {
    what: "a ctx.allSettled fan's completions",
    body: (ctx: WorkflowCtx) => ctx.allSettled('child', [{}, {}, {}]),
    output: [1, 2, 3].map(() => ({ status: 'fulfilled', value: 'done' })) as unknown,
    signal: false,
  },
  {
    what: 'a signal',
    body: (ctx: WorkflowCtx) => ctx.waitForSignal('go'),
    output: 'sent' as unknown,
    signal: true,
  },
];

async function shutdown(all: Instance[], transports: Transport[]): Promise<void> {
  await Promise.allSettled(all.map(({ engine }) => engine.drain(2_000)));
  await Promise.allSettled(transports.map((t) => t.close?.()));
}

/**
 * The contract of a transport's run queue: what `ctx.all` children, starts, re-dispatches and due
 * timers rely on to spread over every instance of a deployment instead of executing on the one that
 * triggered them. Registered as a vitest `describe`; every transport that carries a run queue runs
 * it against its real backend.
 */
export function runRunDispatchContract(
  name: string,
  makeHarness: RunDispatchHarnessFactory,
  options: RunDispatchContractOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fanSize = options.fanSize ?? 300;
  const dedupes = options.dedupesWaitingRuns ?? true;

  describe(`Run dispatch contract: ${name}`, () => {
    async function pairOrSkip(skip: () => void): Promise<[Transport, Transport] | undefined> {
      const harness = await makeHarness();
      if (typeof harness === 'string') {
        console.warn(`[run-dispatch contract] ${name} skipped: ${harness}`);
        skip();
        return undefined;
      }
      return harness.pair();
    }

    for (const { fan, settle } of FANS) {
      it(
        `queues a ${fan}'s children on the transport in batches, and the fan completes`,
        async (ctx) => {
          const pair = await pairOrSkip(() => ctx.skip());
          if (!pair) return;
          // Either instance may run the parent, and so queue the children: record both.
          const a = recorded(pair[0]);
          const b = recorded(pair[1]);
          const store = new InMemoryStateStore();
          const all = instances(store, [a.transport, b.transport]);
          const ran = new Map<number, string[]>();
          registerFan(all, fanSize, ran, settle);
          try {
            for (const { engine } of all) expect(engine.consumeRuns()).toBeTypeOf('function');
            await all[0]?.engine.start('parent', {}, 'p');
            await until(async () => (await store.getRun('p'))?.status === 'completed', timeoutMs);
            expect((await store.getRun('p'))?.output).toEqual(doubled(fanSize, settle));
            const batches = [...a.batches, ...b.batches];
            const queued = batches.flat().map((r) => r.runId);
            const children = (await store.listRuns({ workflow: 'child' })).map((r) => r.id);
            expect(children).toHaveLength(fanSize);
            expect(new Set(queued)).toEqual(new Set(['p', ...children]));
            // Batched: a handful of bulk writes, none over the batch bound, not one per child.
            expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(500);
            expect(batches.length).toBeLessThanOrEqual(Math.ceil(fanSize / 20));
          } finally {
            await shutdown(all, pair);
          }
        },
        timeoutMs + 10_000,
      );

      it(
        `splits a ${fan}'s children across the instances, each child executed once`,
        async (ctx) => {
          const pair = await pairOrSkip(() => ctx.skip());
          if (!pair) return;
          const store = new InMemoryStateStore();
          const all = instances(store, pair);
          const ran = new Map<number, string[]>();
          registerFan(all, fanSize, ran, settle, timeoutMs / 2);
          try {
            for (const { engine } of all) engine.consumeRuns();
            await all[0]?.engine.start('parent', {}, 'p');
            await until(async () => (await store.getRun('p'))?.status === 'completed', timeoutMs);
            expect(ran.size).toBe(fanSize);
            for (const executors of ran.values()) expect(executors).toHaveLength(1);
            const byInstance = new Map<string, number>();
            for (const [executor] of ran.values()) {
              byInstance.set(executor as string, (byInstance.get(executor as string) ?? 0) + 1);
            }
            // The instance that ran the parent did not run every child.
            expect(byInstance.get('instance-0') ?? 0).toBeGreaterThan(0);
            expect(byInstance.get('instance-1') ?? 0).toBeGreaterThan(0);
          } finally {
            await shutdown(all, pair);
          }
        },
        timeoutMs + 10_000,
      );
    }

    it(
      'leaves a run whose queueing failed pending, and the poll takes it',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const a = recorded(pair[0]);
        const store = new InMemoryStateStore();
        const all = instances(store, [a.transport]);
        let turns = 0;
        all[0]?.engine.register('wf', '1', async () => {
          turns += 1;
          return 'done';
        });
        const engine = all[0]?.engine as WorkflowEngine;
        try {
          engine.consumeRuns();
          a.failing.on = true;
          await engine.start('wf', {}, 'lost');
          await engine.start('wf', {}, 'kept');
          await pause(100);
          expect((await store.getRun('lost'))?.status).toBe('pending');
          expect(turns).toBe(0);
          // The broker is back: the poll queues the pending runs again and a consumer takes them.
          a.failing.on = false;
          await engine.runPending();
          // Both were queued by the same poll, but a consumer may take them in either order.
          await until(async () => {
            const [lost, kept] = await Promise.all([store.getRun('lost'), store.getRun('kept')]);
            return lost?.status === 'completed' && kept?.status === 'completed';
          }, timeoutMs);
          // The broker stays down: the poll runs the run itself.
          a.failing.on = true;
          await engine.start('wf', {}, 'down');
          await pause(50);
          expect((await store.getRun('down'))?.status).toBe('pending');
          await engine.runPending();
          await until(async () => (await store.getRun('down'))?.status === 'completed', timeoutMs);
          expect(turns).toBe(3);
        } finally {
          a.failing.on = false;
          await shutdown(all, [pair[0], pair[1]]);
        }
      },
      timeoutMs + 10_000,
    );

    it(
      'skips a queued run that is no longer due',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const store = new InMemoryStateStore();
        // The first instance runs in-process (it never consumes); the second consumes.
        const [local, consumer] = instances(store, pair) as [Instance, Instance];
        let turns = 0;
        for (const { engine } of [local, consumer]) {
          engine.register('done', '1', async () => {
            turns += 1;
            return 1;
          });
          engine.register('waiting', '1', async (ctx) => {
            turns += 1;
            await ctx.waitForSignal('never');
          });
        }
        try {
          await local.engine.start('done', {}, 'finished');
          await local.engine.start('waiting', {}, 'parked');
          await until(
            async () => (await store.getRun('parked'))?.status === 'suspended',
            timeoutMs,
          );
          await until(
            async () => (await store.getRun('finished'))?.status === 'completed',
            timeoutMs,
          );
          expect(turns).toBe(2);
          consumer.engine.consumeRuns();
          await pair[0].dispatchRuns?.([
            { runId: 'finished', reason: 'start', key: '1' },
            { runId: 'parked', reason: 'start', key: '1' },
          ]);
          await pause(1_500);
          expect(turns).toBe(2);
          expect((await store.getRun('parked'))?.status).toBe('suspended');
        } finally {
          await shutdown([local, consumer], pair);
        }
      },
      timeoutMs + 10_000,
    );

    it(
      'a wake resumes a parked run, and skips a finished one',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const store = new InMemoryStateStore();
        const [local, consumer] = instances(store, pair) as [Instance, Instance];
        let parkedTurns = 0;
        let finishedTurns = 0;
        for (const { engine } of [local, consumer]) {
          engine.register('done', '1', async () => {
            finishedTurns += 1;
            return 1;
          });
          engine.register('waiting', '1', async (wctx) => {
            parkedTurns += 1;
            await wctx.waitForSignal('never');
          });
        }
        try {
          await local.engine.start('done', {}, 'finished');
          await local.engine.start('waiting', {}, 'parked');
          await until(
            async () => (await store.getRun('parked'))?.status === 'suspended',
            timeoutMs,
          );
          await until(
            async () => (await store.getRun('finished'))?.status === 'completed',
            timeoutMs,
          );
          consumer.engine.consumeRuns();
          await pair[0].dispatchRuns?.([
            { runId: 'finished', reason: 'wake' },
            { runId: 'parked', reason: 'wake' },
          ]);
          await until(() => parkedTurns === 2, timeoutMs);
          await pause(500);
          expect(parkedTurns).toBe(2);
          expect(finishedTurns).toBe(1);
          expect((await store.getRun('parked'))?.status).toBe('suspended');
        } finally {
          await shutdown([local, consumer], pair);
        }
      },
      timeoutMs + 10_000,
    );

    it(
      "a signal's wake goes through the queue, and signal resolves once it is queued",
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const store = new InMemoryStateStore();
        const a = recorded(pair[0]);
        const all = instances(store, [a.transport, pair[1]]);
        const resumedOn: string[] = [];
        for (const { name, engine } of all) {
          engine.register('waits', '1', async (wctx) => {
            const got = await wctx.waitForSignal<string>('go');
            return wctx.localStep('after', async () => {
              resumedOn.push(name);
              return got;
            });
          });
          engine.consumeRuns();
        }
        try {
          await all[0]?.engine.start('waits', {}, 'w');
          await until(async () => (await store.getRun('w'))?.status === 'suspended', timeoutMs);
          a.batches.length = 0;
          const result = await all[0]?.engine.signal('go', 'payload');
          expect(result?.status).toBe('suspended');
          await until(async () => (await store.getRun('w'))?.status === 'completed', timeoutMs);
          expect(a.batches.flat()).toEqual([{ runId: 'w', reason: 'wake' }]);
          expect((await store.getRun('w'))?.output).toBe('payload');
          expect(resumedOn).toHaveLength(1);
        } finally {
          await shutdown(all, pair);
        }
      },
      timeoutMs + 10_000,
    );

    it(
      'queues due timers on the transport instead of resuming them inline in the poll',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const a = recorded(pair[0]);
        let now = Date.now();
        const store = new InMemoryStateStore();
        const all = instances(store, [a.transport, pair[1]], () => now);
        const n = 40;
        const woke = new Map<number, string[]>();
        for (const { name, engine } of all) {
          engine.register('sleeper', '1', async (ctx, input) => {
            const { i } = input as { i: number };
            await ctx.sleep(1_000);
            return ctx.localStep('after', async () => {
              woke.set(i, [...(woke.get(i) ?? []), name]);
              await pause(15);
              return i;
            });
          });
        }
        try {
          for (const { engine } of all) engine.consumeRuns();
          for (let i = 0; i < n; i += 1) await all[0]?.engine.start('sleeper', { i }, `s${i}`);
          await until(async () => {
            const runs = await store.listRuns({ workflow: 'sleeper', status: 'suspended' });
            return runs.length === n;
          }, timeoutMs);
          a.batches.length = 0;
          now += 2_000;
          const results = await all[0]?.engine.resumeDueTimers(now);
          // Queued, not resumed inline: an inline resume would report each run's new status.
          expect(results).toHaveLength(n);
          expect(results?.every((r) => r.status === 'suspended')).toBe(true);
          expect(new Set(a.batches.flat().map((r) => r.runId)).size).toBe(n);
          // Polled again meanwhile, as the poller does: a timer queued while the run's previous
          // entry was still being handled is queued once more.
          await until(async () => {
            const runs = await store.listRuns({ workflow: 'sleeper', status: 'completed' });
            if (runs.length === n) return true;
            await all[0]?.engine.resumeDueTimers(now);
            await pause(50);
            return false;
          }, timeoutMs);
          for (const executors of woke.values()) expect(executors).toHaveLength(1);
        } finally {
          await shutdown(all, pair);
        }
      },
      timeoutMs + 10_000,
    );

    it(
      'hands a consumer at most `concurrency` runs at once',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const [producer, consumerTransport] = pair;
        let active = 0;
        let peak = 0;
        const handled: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const opts: RunConsumerOptions = { concurrency: 3 };
        const stop = consumerTransport.onDispatchedRun?.(async ({ runId }) => {
          active += 1;
          peak = Math.max(peak, active);
          await gate;
          handled.push(runId);
          active -= 1;
        }, opts);
        try {
          await producer.dispatchRuns?.(Array.from({ length: 8 }, (_, i) => ({ runId: `c${i}` })));
          await until(() => active === 3, timeoutMs);
          await pause(300);
          expect(peak).toBe(3);
          release();
          await until(() => handled.length === 8, timeoutMs);
          expect(new Set(handled).size).toBe(8);
          expect(peak).toBe(3);
        } finally {
          release();
          await stop?.();
          await Promise.allSettled(pair.map((t) => t.close?.()));
        }
      },
      timeoutMs + 10_000,
    );

    it.runIf(!dedupes)(
      'runs one turn of a run queued twice',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const store = new InMemoryStateStore();
        const all = instances(store, pair);
        let turns = 0;
        for (const { engine } of all) {
          engine.register('wf', '1', async (wctx) => {
            turns += 1;
            await wctx.waitForSignal('never');
          });
        }
        try {
          await store.createRun({
            id: 'twice',
            workflow: 'wf',
            workflowVersion: '1',
            status: 'pending',
            input: {},
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          await pair[0].dispatchRuns?.([{ runId: 'twice', reason: 'start', key: '1' }]);
          await pair[0].dispatchRuns?.([{ runId: 'twice', reason: 'start', key: '2' }]);
          for (const { engine } of all) engine.consumeRuns();
          await until(async () => (await store.getRun('twice'))?.status === 'suspended', timeoutMs);
          await pause(1_500);
          expect(turns).toBe(1);
        } finally {
          await shutdown(all, pair);
        }
      },
      timeoutMs + 10_000,
    );

    it.runIf(dedupes)(
      'queues a run once while it waits, however often it is dispatched',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const [producer, consumerTransport] = pair;
        const handled: string[] = [];
        try {
          const once = { runId: 'once', reason: 'start', key: '1' } as const;
          await producer.dispatchRuns?.([once]);
          await producer.dispatchRuns?.([once, once]);
          const stop = consumerTransport.onDispatchedRun?.(
            async ({ runId }) => {
              handled.push(runId);
            },
            { concurrency: 4 },
          );
          await until(() => handled.length >= 1, timeoutMs);
          await pause(500);
          await stop?.();
          expect(handled).toEqual(['once']);
        } finally {
          await Promise.allSettled(pair.map((t) => t.close?.()));
        }
      },
      timeoutMs + 10_000,
    );

    for (const [what, again] of [
      ['a start for a new pending state', { reason: 'start', key: '2' }],
      ['a wake', { reason: 'wake' }],
    ] as const) {
      it(
        `hands a run out again when ${what} lands while its entry is being handled`,
        async (ctx) => {
          const pair = await pairOrSkip(() => ctx.skip());
          if (!pair) return;
          const [producer, consumerTransport] = pair;
          const handled: string[] = [];
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let taken = 0;
          const stop = consumerTransport.onDispatchedRun?.(
            async ({ runId }) => {
              taken += 1;
              if (taken === 1) await gate;
              handled.push(runId);
            },
            { concurrency: 2 },
          );
          try {
            await producer.dispatchRuns?.([{ runId: 'busy', reason: 'start', key: '1' }]);
            await until(() => taken === 1, timeoutMs);
            // Dispatched again while its first entry is still being handled: a requeue (a new pending
            // state) or a wake. The run must get another turn after this one.
            await producer.dispatchRuns?.([{ runId: 'busy', ...again }]);
            await pause(200);
            release();
            await until(() => handled.length >= 2, timeoutMs);
            expect(handled.slice(0, 2)).toEqual(['busy', 'busy']);
          } finally {
            release();
            await stop?.();
            await Promise.allSettled(pair.map((t) => t.close?.()));
          }
        },
        timeoutMs + 10_000,
      );
    }

    it(
      'stops taking runs on stop, and resolves once the runs in flight settled',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const [first, second] = pair;
        const handledFirst: string[] = [];
        let active = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const stopFirst = first.onDispatchedRun?.(
          async ({ runId }) => {
            active += 1;
            await gate;
            handledFirst.push(runId);
            active -= 1;
          },
          { concurrency: 2 },
        );
        try {
          await first.dispatchRuns?.([{ runId: 'in-flight-1' }, { runId: 'in-flight-2' }]);
          await until(() => active === 2, timeoutMs);
          let stopped = false;
          const stopping = stopFirst?.().then(() => {
            stopped = true;
          });
          await pause(200);
          expect(stopped).toBe(false);
          await first.dispatchRuns?.([{ runId: 'after-1' }, { runId: 'after-2' }]);
          release();
          await stopping;
          expect(new Set(handledFirst)).toEqual(new Set(['in-flight-1', 'in-flight-2']));
          await pause(300);
          expect(handledFirst).toHaveLength(2);
          // The runs queued after the stop are still there for another instance.
          const handledSecond: string[] = [];
          const stopSecond = second.onDispatchedRun?.(
            async ({ runId }) => {
              handledSecond.push(runId);
            },
            { concurrency: 2 },
          );
          await until(() => handledSecond.length === 2, timeoutMs);
          expect(new Set(handledSecond)).toEqual(new Set(['after-1', 'after-2']));
          await stopSecond?.();
        } finally {
          release();
          await Promise.allSettled(pair.map((t) => t.close?.()));
        }
      },
      timeoutMs + 10_000,
    );

    it(
      'drain waits for a run taken off the queue, and the draining instance takes no more',
      async (ctx) => {
        const pair = await pairOrSkip(() => ctx.skip());
        if (!pair) return;
        const store = new InMemoryStateStore();
        const all = instances(store, pair);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ranOn = new Map<string, string>();
        for (const { name, engine } of all) {
          engine.register('slow', '1', async (ctx, input) =>
            ctx.localStep('work', async () => {
              const { id } = input as { id: string };
              ranOn.set(id, name);
              if (id === 'held') await gate;
              return id;
            }),
          );
        }
        const [draining, other] = all as [Instance, Instance];
        try {
          draining.engine.consumeRuns();
          await draining.engine.start('slow', { id: 'held' }, 'held');
          await until(() => ranOn.has('held'), timeoutMs);
          let drained = false;
          const drain = draining.engine.drain(timeoutMs).then(() => {
            drained = true;
          });
          await pause(200);
          expect(drained).toBe(false);
          // Started while draining: queued, and left there for another instance.
          await draining.engine.start('slow', { id: 'later' }, 'later');
          await pause(200);
          expect(ranOn.has('later')).toBe(false);
          release();
          await drain;
          expect((await store.getRun('held'))?.status).toBe('completed');
          other.engine.consumeRuns();
          await until(async () => (await store.getRun('later'))?.status === 'completed', timeoutMs);
          expect(ranOn.get('later')).toBe('instance-1');
        } finally {
          release();
          await shutdown(all, pair);
        }
      },
      timeoutMs + 10_000,
    );

    for (const { what, body, output, signal, hold = 'suspend' } of MID_TURN as {
      what: string;
      body: (ctx: WorkflowCtx) => Promise<unknown>;
      output: unknown;
      signal: boolean;
      hold?: 'suspend' | 'placeholder';
    }[]) {
      it(
        `${what}, landing while the parent's turn runs on the other instance, resumes it once that turn ends`,
        async (ctx) => {
          const pair = await pairOrSkip(() => ctx.skip());
          if (!pair) return;
          const inner = new InMemoryStateStore();
          const { store, state } = holdingTurn(inner, hold);
          const now = Date.now();
          // The instance running the parent takes one run at a time: while its turn is held, the
          // children and the wake go to the other instance.
          const [first, second] = pair;
          const busy: Transport = new Proxy(first, {
            get(target, prop, receiver) {
              if (prop === 'onDispatchedRun') {
                return (
                  handler: Parameters<NonNullable<Transport['onDispatchedRun']>>[0],
                  opts: RunConsumerOptions,
                ) => target.onDispatchedRun?.(handler, { ...opts, concurrency: 1 });
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const engines = [busy, second].map(
            (transport) => new WorkflowEngine({ store, transport, clock: () => now }),
          );
          for (const engine of engines) {
            engine.register('child', '1', async () => 'done');
            engine.register('parent', '1', async (wctx) => body(wctx));
          }
          const [holder, other] = engines as [WorkflowEngine, WorkflowEngine];
          try {
            holder.consumeRuns();
            await holder.start('parent', {}, 'p');
            await until(() => state.held, timeoutMs);
            other.consumeRuns();
            if (signal) await other.signal('go', 'sent');
            else if (hold === 'suspend') {
              const n = Array.isArray(output) ? output.length : 1;
              await until(
                async () =>
                  (await inner.listRuns({ workflow: 'child', status: 'completed' })).length >= n,
                timeoutMs,
              );
            }
            // Longer than a lease re-check: the other instance has looked and found the turn running.
            await pause(2_600);
            state.release();
            // Its reconcile wake is minutes away on a clock that never moves: only the wake resumes it.
            await until(async () => (await inner.getRun('p'))?.status === 'completed', timeoutMs);
            expect((await inner.getRun('p'))?.output).toEqual(output);
          } finally {
            state.release();
            await shutdown(
              engines.map((engine, i) => ({ name: `instance-${i}`, engine })),
              pair,
            );
          }
        },
        timeoutMs + 20_000,
      );
    }
  });
}
