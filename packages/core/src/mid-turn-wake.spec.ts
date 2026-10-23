import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StateStore, StepCheckpoint, Transport, WorkflowCtx, WorkflowRun } from './interfaces';
import { InMemoryRunQueue } from './testing/in-memory-run-queue';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A wake that lands while the run's own turn is still executing, on another instance, is not lost:
 * the parent resumes as soon as its turn ends, not on its `reconcileMs` wake (the clock here never
 * gets there).
 */

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, max = 3000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await pause(2);
  }
  throw new Error('condition not met');
}

/**
 * A store that holds one write of run `p` until released: its turn's suspension, or the `running`
 * placeholder of an awaited child.
 */
function holding(inner: InMemoryStateStore, hold: 'suspend' | 'placeholder') {
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
          const patch = (prop === 'updateRun' ? args[1] : args[2]) as Partial<WorkflowRun>;
          return args[0] === 'p' && patch.status === 'suspended';
        }
        if (hold === 'placeholder' && prop === 'saveCheckpoint') {
          const cp = args[0] as StepCheckpoint;
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

interface Shape {
  name: string;
  body: (ctx: WorkflowCtx) => Promise<unknown>;
  /** What the parent returns once resumed. */
  output: unknown;
  /** Which write of the parent's turn is held while the wake lands. */
  hold: 'suspend' | 'placeholder';
  /** How the wake is raised from the other instance, once the turn is held. */
  raise: (other: WorkflowEngine) => Promise<unknown>;
}

const SHAPES: Shape[] = [
  {
    name: 'ctx.child, whose child finishes before its placeholder is written',
    body: (ctx) => ctx.child('child', {}),
    output: 'done',
    hold: 'placeholder',
    raise: async () => undefined,
  },
  {
    name: 'ctx.child, whose child finishes before the turn suspends',
    body: (ctx) => ctx.child('child', {}),
    output: 'done',
    hold: 'suspend',
    raise: async () => undefined,
  },
  {
    name: 'ctx.all',
    body: (ctx) => ctx.all('child', [{}, {}, {}]),
    output: ['done', 'done', 'done'],
    hold: 'suspend',
    raise: async () => undefined,
  },
  {
    name: 'ctx.allSettled',
    body: (ctx) => ctx.allSettled('child', [{}, {}, {}]),
    output: [1, 2, 3].map(() => ({ status: 'fulfilled', value: 'done' })),
    hold: 'suspend',
    raise: async () => undefined,
  },
  {
    name: 'ctx.waitForSignal, signalled from the other instance',
    body: (ctx) => ctx.waitForSignal<string>('go'),
    output: 'sent',
    hold: 'suspend',
    raise: (other) => other.signal('go', 'sent'),
  },
];

describe.each([
  { mode: 'over the run queue', queue: true },
  { mode: 'in-process', queue: false },
])('a wake landing mid-turn on another instance, $mode', ({ queue }) => {
  describe.each(SHAPES)('$name', (shape) => {
    it('resumes the run once its turn ends, without waiting for reconcileMs', async () => {
      const inner = new InMemoryStateStore();
      const { store, state } = holding(inner, shape.hold);
      const now = Date.now();
      const runs = new InMemoryRunQueue();
      // The instance running the parent takes one run at a time, so while its turn is held the
      // children and the wake go to the other instance.
      const one = runs.transport();
      const busy: Transport = {
        ...one,
        onDispatchedRun: (handler, opts) =>
          (one.onDispatchedRun as NonNullable<Transport['onDispatchedRun']>)(handler, {
            ...opts,
            concurrency: 1,
          }),
      };
      const holder = new WorkflowEngine({
        store,
        clock: () => now,
        ...(queue ? { transport: busy } : {}),
      });
      const other = new WorkflowEngine({
        store,
        clock: () => now,
        ...(queue ? { transport: runs.transport() } : {}),
      });
      for (const engine of [holder, other]) {
        engine.register('child', '1', async () => 'done');
        engine.register('parent', '1', async (ctx) => shape.body(ctx));
      }
      if (queue) holder.consumeRuns();
      await holder.start('parent', {}, 'p');
      await until(() => state.held);
      if (queue) other.consumeRuns();
      await shape.raise(other);
      // The children finish while the turn is held (where they can start before it ends).
      if (shape.hold === 'suspend' && !shape.name.includes('waitForSignal')) {
        await until(
          async () =>
            (await inner.listRuns({ workflow: 'child', status: 'completed' })).length >=
            (Array.isArray(shape.output) ? shape.output.length : 1),
        );
      }
      // Longer than the other instance's lease re-check: it has looked, and found the turn running.
      await pause(2_600);
      state.release();
      await until(async () => (await inner.getRun('p'))?.status === 'completed');
      expect((await inner.getRun('p'))?.output).toEqual(shape.output);
      await holder.drain(1_000);
      await other.drain(1_000);
      // Every wake kept for the run was taken: nothing is left behind in the store.
      expect(await inner.takeBufferedSignal('durable:wake-after-turn:p')).toBeNull();
    }, 30_000);
  });
});

describe('a kept wake for a run that is gone', () => {
  it('is taken back when the run was deleted before the request was looked at', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    // The run vanished between the lease attempt and the re-read (a delete or a prune).
    await (
      engine as unknown as { requestWakeAfterTurn(runId: string): Promise<void> }
    ).requestWakeAfterTurn('gone');
    expect(await store.takeBufferedSignal('durable:wake-after-turn:gone')).toBeNull();
  });
});
