import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { SignalTimeoutError } from './errors';
import type { WorkflowLifecycleEvent } from './lifecycle-events';
import { runWaitPrefix, runWaitTargetOf, runWaitToken } from './run-wait';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

function setup(clock?: () => number) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, ...(clock ? { clock } : {}) });
  const seen: WorkflowLifecycleEvent[] = [];
  engine.register('ingest', '1', async (ctx, input) => {
    const { fail } = input as { fail?: boolean };
    await ctx.waitForSignal('ingest-go');
    if (fail) throw new Error('bad file');
    return { rows: 3 };
  });
  engine.register('quick', '1', async () => ({ rows: 1 }));
  engine.register('watcher', '1', async (ctx, input) => {
    const event = await ctx.waitForRun((input as { target: string }).target);
    seen.push(event);
    return event.status;
  });
  return { store, engine, seen };
}

const statusOf = async (store: InMemoryStateStore, id: string) => (await store.getRun(id))?.status;

describe('ctx.waitForRun', () => {
  it('resolves at once when the run already settled before the wait registered', async () => {
    const { store, engine, seen } = setup();
    await engine.start('quick', {}, 'q1');
    await poll(async () => (await statusOf(store, 'q1')) === 'completed');

    await engine.start('watcher', { target: 'q1' }, 'w1');
    await poll(async () => (await statusOf(store, 'w1')) === 'completed');

    expect(seen).toEqual([
      expect.objectContaining({
        runId: 'q1',
        workflow: 'quick',
        status: 'completed',
        output: { rows: 1 },
      }),
    ]);
    expect(await store.listSignalWaiters(runWaitPrefix('q1'))).toEqual([]);
  });

  it('resumes when the run settles while waiting, with its error when it fails', async () => {
    const { store, engine, seen } = setup();
    await engine.start('ingest', { fail: true }, 'i1');
    await poll(async () => (await statusOf(store, 'i1')) === 'suspended');
    await engine.start('watcher', { target: 'i1' }, 'w1');
    await poll(async () => (await statusOf(store, 'w1')) === 'suspended');

    await engine.signal('ingest-go', null);
    await poll(async () => (await statusOf(store, 'w1')) === 'completed');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId: 'i1',
      status: 'failed',
      error: { message: 'bad file' },
    });
    expect(seen[0]).not.toHaveProperty('output');
    expect((await store.getRun('w1'))?.output).toBe('failed');
  });

  it('throws SignalTimeoutError when the run never settles within the timeout', async () => {
    let now = 1_000_000;
    const { store, engine } = setup(() => now);
    let timedOut: unknown;
    engine.register('bounded', '1', async (ctx) => {
      try {
        await ctx.waitForRun('i1', { timeoutMs: '1m' });
        return 'settled';
      } catch (error) {
        if (!(error instanceof SignalTimeoutError)) throw error;
        timedOut = error;
        return 'timed out';
      }
    });
    await engine.start('ingest', {}, 'i1');
    await engine.start('bounded', {}, 'b1');
    await poll(async () => (await statusOf(store, 'b1')) === 'suspended');

    now += 61_000;
    await engine.resumeDueTimers(now);
    await poll(async () => (await statusOf(store, 'b1')) === 'completed');

    expect((await store.getRun('b1'))?.output).toBe('timed out');
    expect(timedOut).toBeInstanceOf(SignalTimeoutError);
    expect(await store.listSignalWaiters(runWaitPrefix('i1'))).toEqual([]);
  });

  it('fails without retrying when the run does not exist', async () => {
    const { store, engine } = setup();
    await engine.start('watcher', { target: 'nope' }, 'w1');
    await poll(async () => (await statusOf(store, 'w1')) === 'failed');

    expect((await store.getRun('w1'))?.error).toMatchObject({
      message: 'run nope not found',
      code: 'run_not_found',
    });
    expect(await store.listSignalWaiters(runWaitPrefix('nope'))).toEqual([]);
  });

  it('delivers from the sweep a run that settled while its delivery was lost', async () => {
    const { store, engine, seen } = setup();
    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await statusOf(store, 'i1')) === 'suspended');
    await engine.start('watcher', { target: 'i1' }, 'w1');
    await poll(async () => (await statusOf(store, 'w1')) === 'suspended');

    // The process "dies" between settling the run and delivering: the settle writes the status,
    // but the waiter listing it would deliver from fails.
    const listSignalWaiters = store.listSignalWaiters.bind(store);
    store.listSignalWaiters = async (prefix) => {
      if (prefix === runWaitPrefix('i1')) throw new Error('crashed');
      return listSignalWaiters(prefix);
    };
    await engine.signal('ingest-go', null);
    await poll(async () => (await statusOf(store, 'i1')) === 'completed');
    await new Promise((r) => setTimeout(r, 30));
    expect(await statusOf(store, 'w1')).toBe('suspended');

    store.listSignalWaiters = listSignalWaiters;
    expect(await engine.sweepRunWaits()).toBe(1);
    await poll(async () => (await statusOf(store, 'w1')) === 'completed');
    expect(seen).toEqual([expect.objectContaining({ runId: 'i1', status: 'completed' })]);
    expect(await engine.sweepRunWaits()).toBe(0);
  });

  it('waits through a continue-as-new chain for its last run', async () => {
    const { store, engine, seen } = setup();
    engine.register('counter', '1', async (ctx, input) => {
      const n = (input as { n: number }).n;
      if (n === 1) await ctx.waitForSignal('counter-go');
      if (n < 3) await ctx.continueAsNew({ n: n + 1 });
      return n;
    });
    await engine.start('counter', { n: 1 }, 'c1');
    await poll(async () => (await statusOf(store, 'c1')) === 'suspended');
    await engine.start('watcher', { target: 'c1' }, 'w1');
    await poll(async () => (await statusOf(store, 'w1')) === 'suspended');

    await engine.signal('counter-go', null);
    await poll(async () => (await statusOf(store, 'c1~2')) === 'completed');
    await engine.sweepRunWaits();
    await poll(async () => (await statusOf(store, 'w1')) === 'completed');

    expect(seen).toEqual([expect.objectContaining({ runId: 'c1~2', output: 3 })]);
  });

  it('replays from the recorded result, not the run as it is now', async () => {
    const { store, engine } = setup();
    let replays = 0;
    engine.register('twice', '1', async (ctx) => {
      replays += 1;
      const event = await ctx.waitForRun('q1');
      await ctx.waitForSignal('twice-go');
      return event.output;
    });
    await engine.start('quick', {}, 'q1');
    await poll(async () => (await statusOf(store, 'q1')) === 'completed');
    await engine.start('twice', {}, 't1');
    await poll(async () => (await statusOf(store, 't1')) === 'suspended');

    await store.updateRun('q1', { output: { rows: 999 } });
    await engine.signal('twice-go', null);
    await poll(async () => (await statusOf(store, 't1')) === 'completed');

    // The output is the proof: a replay that read the run again would see 999. How many turns
    // replayed the body depends on scheduling.
    expect(replays).toBeGreaterThanOrEqual(2);
    expect((await store.getRun('t1'))?.output).toEqual({ rows: 1 });
  });

  it('reads the target back from a waiter token, even when the id contains #', () => {
    const token = runWaitToken('a#b', 'w#1', 4);
    expect(token.startsWith(runWaitPrefix('a'))).toBe(true);
    expect(runWaitTargetOf({ token, runId: 'w#1', seq: 4 })).toBe('a#b');
    expect(runWaitTargetOf({ token: 'event:abc', runId: 'w', seq: 1 })).toBeUndefined();
  });
});
