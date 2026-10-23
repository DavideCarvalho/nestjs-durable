import { describe, expect, it } from 'vitest';
import { BoundedRunner } from './bounded-runner';
import { WorkflowEngine } from './engine';
import type { StateStore } from './interfaces';
import { InMemoryRunQueue } from './testing/in-memory-run-queue';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * One budget of 256 covers everything an instance takes on itself: the child starts of a fan and
 * the turns it executes, whether it dispatched them to itself or took them off the run queue.
 */

async function until(check: () => boolean | Promise<boolean>, max = 20_000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A store whose child-run inserts take a few ms, counting how many are in flight. */
function slowInserts(inner: InMemoryStateStore, onChange: (delta: number) => void): StateStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop !== 'createRun') return value.bind(target);
      return async (...args: unknown[]) => {
        const child = (args[0] as { workflow: string }).workflow === 'child';
        if (child) onChange(1);
        try {
          if (child) await pause(3);
          return await value.apply(target, args);
        } finally {
          if (child) onChange(-1);
        }
      };
    },
  });
}

describe.each([
  { name: 'in-process', queue: false },
  { name: 'over the run queue', queue: true },
])('the in-process budget, $name', ({ queue }) => {
  it('caps child starts and executions together at 256', async () => {
    let inFlight = 0;
    let peak = 0;
    const track = (delta: number) => {
      inFlight += delta;
      peak = Math.max(peak, inFlight);
    };
    const inner = new InMemoryStateStore();
    const store = slowInserts(inner, track);
    const engine = new WorkflowEngine({
      store,
      reconcileMs: 0,
      ...(queue ? { transport: new InMemoryRunQueue().transport() } : {}),
    });
    engine.register('child', '1', async (ctx) =>
      ctx.localStep('work', async () => {
        track(1);
        await pause(3);
        track(-1);
        return 1;
      }),
    );
    for (const settle of [false, true]) {
      engine.register(`parent-${settle}`, '1', async (ctx) => {
        const inputs = Array.from({ length: 900 }, () => ({}));
        const out = settle ? await ctx.allSettled('child', inputs) : await ctx.all('child', inputs);
        return out.length;
      });
    }
    if (queue) expect(engine.consumeRuns()).toBeTypeOf('function');
    await engine.start('parent-false', {}, 'pa');
    await engine.start('parent-true', {}, 'ps');
    await until(async () => (await inner.getRun('pa'))?.status === 'completed');
    await until(async () => (await inner.getRun('ps'))?.status === 'completed');
    expect((await inner.getRun('pa'))?.output).toBe(900);
    expect((await inner.getRun('ps'))?.output).toBe(900);
    expect(peak).toBeLessThanOrEqual(256);
    expect(peak).toBeGreaterThan(64);
  }, 60_000);
});

describe('BoundedRunner.run', () => {
  it('resolves when its task settles, and when the task is dropped before it ran', async () => {
    const runner = new BoundedRunner(1);
    let release!: () => void;
    const first = runner.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let ran = false;
    const second = runner.run(async () => {
      ran = true;
    });
    await pause(5);
    expect(runner.size).toBe(2);
    runner.clear();
    await second;
    expect(ran).toBe(false);
    release();
    await first;
    await pause(1);
    expect(runner.size).toBe(0);
  });
});
