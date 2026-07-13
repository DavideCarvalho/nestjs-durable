import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { SignalWaiter } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * Reliable (buffered) EVENTS — the events-side counterpart of signal-waiter-race.spec.ts's coverage.
 * Before this wave, `engine.publishEvent` DROPPED a publish that matched no live waiter, and
 * `ctx.waitForEvent` never consulted any buffer — the same lost-wake class of bug `ad5c510` closed for
 * signals, just unfixed for events. `GatedStateStore` makes the race windows deterministic instead of
 * hoping real timing lines up, exactly like the signal spec's own gate.
 */
class GatedStateStore extends InMemoryStateStore {
  private readonly gates = new Map<
    string,
    { reachedResolve: () => void; releasePromise: Promise<void> }
  >();

  arm(hook: string): { reached: Promise<void>; release: () => void } {
    let reachedResolve!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    this.gates.set(hook, { reachedResolve, releasePromise });
    return { reached, release: releaseResolve };
  }

  private async pause(hook: string): Promise<void> {
    const gate = this.gates.get(hook);
    if (!gate) return;
    this.gates.delete(hook);
    gate.reachedResolve();
    await gate.releasePromise;
  }

  override async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    await this.pause('beforePutSignalWaiter');
    await super.putSignalWaiter(waiter);
  }

  override async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    await this.pause('beforeBufferEvent');
    await super.bufferEvent(input);
  }
}

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitUntil timed out');
}

describe('event buffering — publish-before-wait reliability', () => {
  it('a publish with no live waiter buffers, and a later matching waitForEvent consumes it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ decision: string }>('order.decided', {
        match: { decision: 'approved' },
      }),
    );

    const touched = await engine.publishEvent('order.decided', { decision: 'approved' });
    expect(touched).toBe(0); // nobody was waiting yet — buffered, not delivered live

    const result = await startRun(engine, 'approval', {}, 'r1');
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ decision: 'approved' });
    expect(await store.listBufferedEvents('order.decided', 10)).toEqual([]); // consumed
  });

  it('a match-rejecting waiter does NOT consume a buffered event it does not accept', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('rejector', '1', async (ctx) =>
      ctx.waitForEvent<{ decision: string }>('order.decided', { match: { decision: 'rejected' } }),
    );

    await engine.publishEvent('order.decided', { decision: 'approved' });
    const result = await startRun(engine, 'rejector', {}, 'r1');
    expect(result.status).toBe('suspended'); // the buffered payload doesn't match — left untouched
    expect(await store.listBufferedEvents('order.decided', 10)).toEqual([
      {
        id: expect.any(String),
        payload: { decision: 'approved' },
        publishedAt: expect.any(Number),
      },
    ]);
  });

  it('point-to-point redelivery: once a matching waiter claims the buffered copy, a second matching waiter gets nothing', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('approver', '1', async (ctx) =>
      ctx.waitForEvent<{ decision: string }>('order.decided', { match: { decision: 'approved' } }),
    );

    await engine.publishEvent('order.decided', { decision: 'approved' });

    const first = await startRun(engine, 'approver', {}, 'r1');
    expect(first.status).toBe('completed');
    expect(first.output).toEqual({ decision: 'approved' });

    // Nothing left buffered — the second matching waiter suspends instead of double-consuming.
    const second = await startRun(engine, 'approver', {}, 'r2');
    expect(second.status).toBe('suspended');
  });

  it('opts.buffer === false opts out of buffering entirely', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('approver', '1', async (ctx) => ctx.waitForEvent('order.decided'));

    const touched = await engine.publishEvent(
      'order.decided',
      { decision: 'approved' },
      { buffer: false },
    );
    expect(touched).toBe(0);
    expect(await store.listBufferedEvents('order.decided', 10)).toEqual([]); // nothing buffered

    const result = await startRun(engine, 'approver', {}, 'r1');
    expect(result.status).toBe('suspended'); // nothing to consume
  });
});

describe('event buffering — live fan-out stays live-only', () => {
  it('a publish that resumes ≥1 live waiter is NOT buffered', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('waiter', '1', async (ctx) => ctx.waitForEvent<{ n: number }>('tick'));

    // Each start is awaited to full suspension (matching the existing events.spec.ts convention)
    // before the next — publishing while a turn is STILL unwinding toward `suspended` is a separate,
    // real race (`resume`'s own re-entrancy guard), not what this case is about.
    const r1 = await startRun(engine, 'waiter', {}, 'r1');
    expect(r1.status).toBe('suspended');
    const r2 = await startRun(engine, 'waiter', {}, 'r2');
    expect(r2.status).toBe('suspended');

    const touched = await engine.publishEvent('tick', { n: 7 });
    expect(touched).toBe(2); // both live waiters resumed

    expect((await engine.waitForRun('r1')).output).toEqual({ n: 7 });
    expect((await engine.waitForRun('r2')).output).toEqual({ n: 7 });
    expect(await store.listBufferedEvents('tick', 10)).toEqual([]); // fan-out, not buffered
  });
});

describe('event buffering — interleaving windows (the lost-wake race, closed)', () => {
  it("waiter registers, THEN a concurrent publish finds no waiter yet and buffers — the waiter's own post-register scan catches it", async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ ok: boolean }>('go', { match: { ok: true } }),
    );

    // Pause the run's own waiter registration (putSignalWaiter) — so when the publish below runs,
    // NOTHING is registered yet (the row hasn't landed), exactly the window the bug lived in.
    const gate = store.arm('beforePutSignalWaiter');
    const resultPromise = startRun(engine, 'approval', {}, 'r1');
    await gate.reached;

    const touched = await engine.publishEvent('go', { ok: true });
    expect(touched).toBe(0); // no live waiter yet — buffered instead of dropped

    // Release: putSignalWaiter completes, then the fix's post-register buffer scan runs and must find
    // the payload we just buffered — resolving instead of suspending forever.
    gate.release();
    const result = await resultPromise;
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ ok: true });
    expect(await store.listSignalWaiters('event:')).toEqual([]); // its own waiter row was cleaned up
  });

  it("mirror-image window: a waiter registers between publishEvent's initial miss and its buffer write", async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ ok: boolean }>('go', { match: { ok: true } }),
    );

    // publishEvent's initial listSignalWaiters finds nothing (no waiter yet), then pauses RIGHT BEFORE
    // it writes the buffer.
    const gate = store.arm('beforeBufferEvent');
    const publishPromise = engine.publishEvent('go', { ok: true });
    await gate.reached;

    // The waiter registers (and, since nothing is buffered yet at its own scan, suspends) WHILE
    // publishEvent is paused mid-delivery. Fire-and-forget via `engine.start` (NOT `startRun`): its
    // `waitForRun` settles on ANY non-running status, including an intermediate `suspended` — which
    // would resolve on the run's FIRST suspend, before the reclaim below ever lands (see the mirror
    // signal spec's identical note).
    await engine.start('approval', {}, 'r1');
    await waitUntil(async () => (await store.listSignalWaiters('event:')).length > 0);

    // Release: publishEvent buffers, then re-checks listSignalWaiters — finds the waiter that
    // registered in the window — and reclaims + delivers instead of leaving both rows stranded.
    gate.release();
    const touched = await publishPromise;
    expect(touched).toBe(1);
    const result = await store.getRun('r1');
    expect(result?.status).toBe('completed');
    expect(result?.output).toEqual({ ok: true });
    expect(await store.listSignalWaiters('event:')).toEqual([]);
    expect(await store.listBufferedEvents('go', 10)).toEqual([]);
  });
});

describe('event buffering — reconcile sweep', () => {
  it('pairs a stranded buffer + waiter (crash between the two ops) on the next due-timer sweep', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ by: string }>('go', { match: { by: 'davi' } }),
    );

    const started = await startRun(engine, 'approval', {}, 'r1');
    expect(started.status).toBe('suspended'); // parked on the event waiter; nothing buffered yet

    // Simulate the crash: an event payload lands in the buffer directly, without going through the
    // normal publishEvent/waitForEvent pairing machinery — both rows now sit stranded.
    await store.bufferEvent({
      name: 'go',
      payload: { by: 'davi' },
      id: 'crash-1',
      publishedAt: now,
    });

    const run = await store.getRun('r1');
    now = (run?.wakeAt ?? 0) + 1; // past the reconcileMs fallback wakeAt this suspend carries
    const results = await engine.resumeDueTimers(now);

    const settled = results.find((r) => r.runId === 'r1');
    expect(settled?.status).toBe('completed');
    expect(settled?.output).toEqual({ by: 'davi' });
    expect(await store.listBufferedEvents('go', 10)).toEqual([]); // paired and cleaned up
  });

  it('eventBufferTtlMs prunes an expired buffered event during the reconcile scan instead of delivering it', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now, eventBufferTtlMs: 5_000 });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ by: string }>('go', { match: { by: 'davi' } }),
    );

    const started = await startRun(engine, 'approval', {}, 'r1');
    expect(started.status).toBe('suspended');

    // A MATCHING event that's already stale by the time the reconcile sweep gets to it — TTL pruning
    // must drop it rather than deliver it (expired means gone, not "deliver anyway").
    await store.bufferEvent({
      name: 'go',
      payload: { by: 'davi' },
      id: 'stale-1',
      publishedAt: 1_000,
    });

    const run = await store.getRun('r1');
    now = (run?.wakeAt ?? 0) + 1 + 5_000; // past both the reconcile wakeAt and the TTL window
    const results = await engine.resumeDueTimers(now);

    const settled = results.find((r) => r.runId === 'r1');
    expect(settled?.status).toBe('suspended'); // pruned, not delivered
    expect(await store.listBufferedEvents('go', 10)).toEqual([]); // gone (pruned)
  });
});

describe('event buffering — determinism', () => {
  it('consuming a buffered event lands at the SAME logical position as a live delivery (no seq drift)', async () => {
    async function run(mode: 'live' | 'buffered'): Promise<{ status: string; output: unknown }> {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store, reconcileMs: 0 });
      engine.register('flow', '1', async (ctx) => {
        const evt = await ctx.waitForEvent<{ n: number }>('go');
        return ctx.localStep('double', async () => evt.n * 2);
      });
      if (mode === 'buffered') {
        await engine.publishEvent('go', { n: 21 });
        const result = await startRun(engine, 'flow', {}, 'r1');
        return { status: result.status, output: result.output };
      }
      const suspended = await startRun(engine, 'flow', {}, 'r1');
      expect(suspended.status).toBe('suspended'); // fully unwound before the live publish below
      await engine.publishEvent('go', { n: 21 });
      const result = await engine.waitForRun('r1');
      return { status: result.status, output: result.output };
    }

    const live = await run('live');
    const buffered = await run('buffered');
    expect(live).toEqual(buffered);
    expect(buffered).toEqual({ status: 'completed', output: 42 });
  });
});
