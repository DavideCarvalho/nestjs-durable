import { describe, expect, it } from 'vitest';
import { isWorkflowControlFlowSignal } from './control-flow-signal';
import { WorkflowEngine } from './engine';
import type { WaitAnyResult, WaitCondition, WorkflowCtx } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { ANY_WAIT_GROUP } from './wait-any';

const HOUR = 3_600_000;

function setup() {
  const store = new InMemoryStateStore();
  let now = Date.parse('2026-11-07T00:00:00.000Z');
  const engine = new WorkflowEngine({ store, clock: () => now });
  return {
    store,
    engine,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
    now: () => now,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('ctx.waitForAny', () => {
  it('resolves with the first condition, typed by key, and replays the same winner', async () => {
    const { engine } = setup();
    const seen: unknown[] = [];
    engine.register('order', '1', async (ctx: WorkflowCtx) => {
      const outcome = await ctx.waitForAny('delivery', {
        delivered: ctx.signalWait<{ at: string }>('delivered:o1'),
        cancelled: ctx.signalWait<{ reason: string }>('cancelled:o1'),
        timeout: ctx.timer('3d'),
      });
      // Type-level: narrowing on key narrows value.
      if (outcome.key === 'delivered') {
        const at: string = outcome.value.at;
        seen.push(at);
      }
      await ctx.localStep('after', async () => 'ok');
      return outcome;
    });
    expect((await startRun(engine, 'order', {}, 'r1')).status).toBe('suspended');
    const done = await engine.signal('delivered:o1', { at: 'noon' });
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ key: 'delivered', value: { at: 'noon' } });
    // The replay that completed the run re-entered the wait and got the journaled winner.
    expect(seen).toEqual(['noon']);
  });

  it('lets a timer win, and leaves a later signal on a losing condition buffered', async () => {
    const { engine, advance } = setup();
    engine.register('w', '1', async (ctx) => {
      const first = await ctx.waitForAny('a', {
        go: ctx.signalWait<string>('go'),
        late: ctx.timer('1h'),
      });
      const next = await ctx.waitForSignal<string>('go');
      return { first, next };
    });
    expect((await startRun(engine, 'w', {}, 'r1')).status).toBe('suspended');
    const at = advance(HOUR);
    await engine.resumeDueTimers(at);
    // Now waiting on the plain waitForSignal('go').
    const done = await engine.signal('go', 'payload');
    expect(done?.output).toEqual({ first: { key: 'late', value: null }, next: 'payload' });
  });

  it('does not consume a losing signal: it stays buffered for a later wait on its token', async () => {
    const { engine } = setup();
    engine.register('w', '1', async (ctx) => {
      const first = await ctx.waitForAny('a', {
        a: ctx.signalWait<string>('sig-a'),
        b: ctx.signalWait<string>('sig-b'),
      });
      const a = await ctx.waitForSignal<string>('sig-a');
      return { first, a };
    });
    // Both signals are sent BEFORE the run reaches the wait: the one sent first wins, the other stays.
    await engine.signal('sig-b', 'B');
    await engine.signal('sig-a', 'A');
    const done = await startRun(engine, 'w', {}, 'r1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ first: { key: 'b', value: 'B' }, a: 'A' });
  });

  it('re-buffers a signal that arrives on a condition whose wait was already won', async () => {
    const { engine, store } = setup();
    engine.register('w', '1', async (ctx) => {
      const first = await ctx.waitForAny('a', {
        a: ctx.signalWait<string>('sig-a'),
        b: ctx.signalWait<string>('sig-b'),
      });
      const b = await ctx.waitForSignal<string>('sig-b');
      return { first, b };
    });
    expect((await startRun(engine, 'w', {}, 'r1')).status).toBe('suspended');
    // A second waiter for `sig-b` left over from the wait (as a replay racing the winner can leave):
    // the signal takes it, loses the compare-and-set, and must be buffered again, not dropped.
    const winner = await engine.signal('sig-a', 'A');
    expect(winner?.status).toBe('suspended');
    await store.putSignalWaiter({
      token: 'sig-b2',
      runId: 'r1',
      seq: 0,
      parallelGroup: ANY_WAIT_GROUP,
    });
    await engine.signal('sig-b2', 'stale');
    expect(await store.takeBufferedSignal('sig-b2')).toEqual({ payload: 'stale' });
    const done = await engine.signal('sig-b', 'B');
    expect(done?.output).toEqual({ first: { key: 'a', value: 'A' }, b: 'B' });
  });

  it('does not hand a signal to a run that was cancelled while waiting', async () => {
    const { engine, store } = setup();
    engine.register('w', '1', async (ctx) =>
      ctx.waitForAny('a', { a: ctx.signalWait('sig-a'), t: ctx.timer('1h') }),
    );
    await startRun(engine, 'w', {}, 'r1');
    await engine.cancel('r1');
    expect((await engine.getRun('r1'))?.status).toBe('cancelled');
    expect(await engine.signal('sig-a', 'kept')).toBeNull();
    expect(await store.takeBufferedSignal('sig-a')).toEqual({ payload: 'kept' });
    expect(await store.listSignalWaiters('sig-a')).toEqual([]);
  });

  it('a signal sent after a timer deadline loses to the timer even if no worker ran at the deadline', async () => {
    const { engine, advance, store } = setup();
    engine.register('w', '1', async (ctx) => {
      const first = await ctx.waitForAny('a', {
        go: ctx.signalWait<string>('go'),
        late: ctx.timer('1h'),
      });
      return first;
    });
    expect((await startRun(engine, 'w', {}, 'r1')).status).toBe('suspended');
    advance(HOUR + 1);
    // No timer poll ran; the signal lands first.
    const result = await engine.signal('go', 'too late');
    await settle();
    expect((await engine.getRun('r1'))?.output).toEqual({ key: 'late', value: null });
    expect(result?.output).toEqual({ key: 'late', value: null });
    // ...and the late signal was not consumed.
    expect(await store.takeBufferedSignal('go')).toEqual({ payload: 'too late' });
  });

  it('counts timers from when the wait is first reached', async () => {
    const { engine, advance, store } = setup();
    engine.register('w', '1', async (ctx) => {
      await ctx.sleep('1h');
      return ctx.waitForAny('a', { t: ctx.timer('2h'), go: ctx.signalWait('go') });
    });
    await startRun(engine, 'w', {}, 'r1');
    await engine.resumeDueTimers(advance(HOUR));
    const cp = await store.getCheckpoint('r1', 1);
    expect(cp?.status).toBe('pending');
    expect((await store.getRun('r1'))?.wakeAt).toBe(cp?.wakeAt);
    await engine.resumeDueTimers(advance(HOUR));
    expect((await store.getRun('r1'))?.status).toBe('suspended');
    await engine.resumeDueTimers(advance(HOUR));
    expect((await store.getRun('r1'))?.output).toEqual({ key: 't', value: null });
  });

  it('accepts an absolute `until` timer', async () => {
    const { engine, now, advance } = setup();
    const at = now() + 5 * HOUR;
    engine.register('w', '1', async (ctx) =>
      ctx.waitForAny('a', { t: ctx.timer({ until: new Date(at) }), go: ctx.signalWait('go') }),
    );
    await startRun(engine, 'w', {}, 'r1');
    await engine.resumeDueTimers(advance(4 * HOUR));
    expect((await engine.getRun('r1'))?.status).toBe('suspended');
    await engine.resumeDueTimers(advance(HOUR));
    expect((await engine.getRun('r1'))?.output).toEqual({ key: 't', value: null });
  });

  it('removes the losing conditions waiters once a condition wins', async () => {
    const { engine, store } = setup();
    engine.register('w', '1', async (ctx) => {
      await ctx.waitForAny('a', { a: ctx.signalWait('sig-a'), b: ctx.signalWait('sig-b') });
      return ctx.waitForSignal('other');
    });
    await startRun(engine, 'w', {}, 'r1');
    expect((await store.listSignalWaiters('sig-')).map((w) => w.token).sort()).toEqual([
      'sig-a',
      'sig-b',
    ]);
    await engine.signal('sig-a', 1);
    expect(await store.listSignalWaiters('sig-')).toEqual([]);
  });

  it('races a child: the child output wins; a failed child throws', async () => {
    const { engine } = setup();
    engine.register('child', '1', async (ctx, input) => {
      const { fail } = input as { fail: boolean };
      await ctx.waitForSignal('child-go');
      if (fail) throw new Error('boom');
      return 'child-out';
    });
    engine.register('parent', '1', async (ctx, input) => {
      const id = await ctx.startChild('child', input, 'kid');
      try {
        return await ctx.waitForAny('race', {
          child: ctx.childWait<string>(id),
          stop: ctx.signalWait('stop'),
        });
      } catch (err) {
        if (isWorkflowControlFlowSignal(err)) throw err;
        return { threw: (err as Error).message };
      }
    });
    await startRun(engine, 'parent', { fail: false }, 'p1');
    await engine.signal('child-go', null);
    await settle();
    expect((await engine.getRun('p1'))?.output).toEqual({ key: 'child', value: 'child-out' });

    const second = setup();
    second.engine.register('child', '1', async (ctx) => {
      await ctx.waitForSignal('child-go');
      throw new Error('boom');
    });
    second.engine.register('parent', '1', async (ctx) => {
      const id = await ctx.startChild('child', {}, 'kid');
      try {
        return await ctx.waitForAny('race', {
          child: ctx.childWait(id),
          stop: ctx.signalWait('stop'),
        });
      } catch (err) {
        if (isWorkflowControlFlowSignal(err)) throw err;
        return { threw: (err as Error).message };
      }
    });
    await startRun(second.engine, 'parent', {}, 'p1');
    await second.engine.signal('child-go', null);
    await settle();
    expect((await second.engine.getRun('p1'))?.output).toEqual({
      threw: expect.stringContaining('boom'),
    });
  });

  it('leaves a losing child running; a later ctx.child join by id gets its result', async () => {
    const { engine } = setup();
    engine.register('child', '1', async (ctx) => {
      await ctx.waitForSignal('child-go');
      return 'late-child';
    });
    engine.register('parent', '1', async (ctx) => {
      const id = await ctx.startChild('child', {}, 'kid');
      const first = await ctx.waitForAny('race', {
        child: ctx.childWait<string>(id),
        stop: ctx.signalWait<string>('stop'),
      });
      const joined = await ctx.child<string>('child', {}, id);
      return { first, joined };
    });
    await startRun(engine, 'parent', {}, 'p1');
    await engine.signal('stop', 'now');
    await settle();
    expect((await engine.getRun('kid'))?.status).toBe('suspended');
    await engine.signal('child-go', null);
    await settle();
    await settle();
    expect((await engine.getRun('p1'))?.output).toEqual({
      first: { key: 'stop', value: 'now' },
      joined: 'late-child',
    });
  });

  it('resolves at once when a raced child already finished', async () => {
    const { engine } = setup();
    engine.register('child', '1', async () => 'quick');
    engine.register('parent', '1', async (ctx) => {
      const id = await ctx.startChild('child', {}, 'kid');
      await ctx.waitForSignal('later');
      return ctx.waitForAny('race', { c: ctx.childWait<string>(id), t: ctx.timer('1h') });
    });
    await startRun(engine, 'parent', {}, 'p1');
    await settle();
    expect((await engine.getRun('kid'))?.status).toBe('completed');
    const done = await engine.signal('later', null);
    expect(done?.output).toEqual({ key: 'c', value: 'quick' });
  });

  it('fails a replay that reaches the position with another wait name', async () => {
    const { engine } = setup();
    let name = 'first';
    engine.register('w', '1', async (ctx) => ctx.waitForAny(name, { a: ctx.signalWait('sig-a') }));
    await startRun(engine, 'w', {}, 'r1');
    name = 'renamed';
    const done = await engine.signal('sig-a', 1);
    expect(done?.status).toBe('failed');
    expect(done?.error?.message).toMatch(/non-determinism/);
  });

  it('types the result per key', () => {
    type C = { a: WaitCondition<string>; b: WaitCondition<null> };
    const r = {} as WaitAnyResult<C>;
    if (r.key === 'a') {
      const s: string = r.value;
      void s;
    } else {
      const n: null = r.value;
      void n;
    }
  });
});

describe('engine.signal(..., { id })', () => {
  it('stores a signal re-sent with the same id once, and the first payload wins', async () => {
    const { engine, store } = setup();
    expect(await engine.signal('paid:o1', { n: 1 }, { id: 'evt-1' })).toBeNull();
    expect(await engine.signal('paid:o1', { n: 2 }, { id: 'evt-1' })).toBeNull();
    expect(await store.takeBufferedSignal('paid:o1')).toEqual({ payload: { n: 1 } });
    expect(await store.takeBufferedSignal('paid:o1')).toBeNull();
  });

  it('delivers a duplicate to nobody: a waiting run is resumed once', async () => {
    const { engine } = setup();
    let resumed = 0;
    engine.register('w', '1', async (ctx) => {
      const a = await ctx.waitForSignal('paid');
      resumed += 1;
      const b = await ctx.waitForSignal('paid');
      return [a, b];
    });
    await startRun(engine, 'w', {}, 'r1');
    await engine.signal('paid', 1, { id: 'x' });
    expect(resumed).toBe(1);
    await engine.signal('paid', 1, { id: 'x' });
    expect((await engine.getRun('r1'))?.status).toBe('suspended');
    const done = await engine.signal('paid', 2, { id: 'y' });
    expect(done?.output).toEqual([1, 2]);
  });

  it('scopes ids per token, and forgets an id once it expires', async () => {
    const { engine, store, advance } = setup();
    await engine.signal('a', 1, { id: 'same' });
    await engine.signal('b', 2, { id: 'same' });
    expect(await store.takeBufferedSignal('b')).toEqual({ payload: 2 });
    await engine.signal('a', 3, { id: 'short', idTtl: '1m' });
    advance(60_001);
    await engine.signal('a', 4, { id: 'short' });
    expect(await store.takeBufferedSignal('a')).toEqual({ payload: 1 });
    expect(await store.takeBufferedSignal('a')).toEqual({ payload: 3 });
    expect(await store.takeBufferedSignal('a')).toEqual({ payload: 4 });
  });

  it('sweeps expired ids', async () => {
    const { engine, advance } = setup();
    await engine.signal('a', 1, { id: 'one', idTtl: 1000 });
    await engine.signal('a', 1, { id: 'two' });
    expect(await engine.sweepExpiredSignalIds()).toBe(0);
    expect(await engine.sweepExpiredSignalIds(advance(1000))).toBe(1);
  });

  it('forgets the id when the signal could not be stored, so a retry gets through', async () => {
    const { engine, store } = setup();
    const buffer = store.bufferSignal.bind(store);
    let failOnce = true;
    store.bufferSignal = async (token, payload) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('db down');
      }
      return buffer(token, payload);
    };
    await expect(engine.signal('t', 1, { id: 'm' })).rejects.toThrow('db down');
    await engine.signal('t', 1, { id: 'm' });
    expect(await store.takeBufferedSignal('t')).toEqual({ payload: 1 });
  });

  it('throws on a store that cannot deduplicate', async () => {
    const store = new InMemoryStateStore();
    (store as { claimSignalId?: unknown }).claimSignalId = undefined;
    const engine = new WorkflowEngine({ store });
    await expect(engine.signal('t', 1, { id: 'm' })).rejects.toThrow(/claimSignalId/);
  });
});
