import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { SignalTimeoutError } from './errors';
import type { HistoryEvent, SignalWaiter, WorkflowDecision, WorkflowExecutor } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * REGRESSION cover for the HITL signal-delivery race: a signal delivered between a waiter's
 * buffered-check and its waiter-row insert (or the mirror-image on the signaling side) used to be
 * lost forever — the run stayed suspended, the buffered payload sat unpaired, and nothing ever
 * resumed it (observed in production as an agent HITL approve/reject landing in the window).
 *
 * `GatedStateStore` makes the race DETERMINISTIC instead of hoping real timing lines up: arming a
 * hook lets a test learn the instant the engine reaches that exact store call (`gate.reached`) and
 * hold it there until the test calls `gate.release()`, so the opposing actor (an `engine.signal` call,
 * or a concurrent `waitForSignal`) can be driven to run inside the narrow window on every execution.
 */
class GatedStateStore extends InMemoryStateStore {
  private readonly gates = new Map<
    string,
    { reachedResolve: () => void; releasePromise: Promise<void> }
  >();

  /** Arm `hook`: the NEXT call to it resolves `reached` immediately, then blocks until `release()`. */
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

  override async bufferSignal(token: string, payload: unknown): Promise<void> {
    await this.pause('beforeBufferSignal');
    await super.bufferSignal(token, payload);
  }
}

/** Stand-in for a Python workflow that waits on a signal: `ctx.wait_signal("go")` then returns it. */
function waitSignalExecutor(token: string): WorkflowExecutor {
  return {
    async advance(run, history: HistoryEvent[]): Promise<WorkflowDecision> {
      const bySeq = new Map(history.map((e) => [e.seq, e]));
      const base = { taskId: 'task', runId: run.id } as const;
      if (!bySeq.has(0)) {
        return {
          ...base,
          status: 'continue',
          commands: [{ kind: 'waitSignal', seq: 0, signal: token }],
        };
      }
      return { ...base, status: 'completed', commands: [], output: bySeq.get(0)?.output };
    },
  };
}

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitUntil timed out');
}

describe('signal/waiter race — the lost-wake window and its close', () => {
  it('in-process, unbounded waitForSignal: a signal delivered right before the waiter registers is not lost', async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) => ctx.waitForSignal<{ by: string }>('go'));

    const gate = store.arm('beforePutSignalWaiter');
    const resultPromise = startRun(engine, 'approval', {}, 'r1');
    await gate.reached; // the run's first turn is paused RIGHT BEFORE it registers the waiter.

    // The signal lands in the exact window the bug describes: no waiter is registered yet, so
    // engine.signal buffers it instead of delivering directly.
    const delivered = await engine.signal('go', { by: 'davi' });
    expect(delivered).toBeNull();

    // Release the waiter registration: it re-checks the buffer immediately afterward (the fix) and
    // must find the payload we just buffered, resolving instead of suspending forever.
    gate.release();
    const result = await resultPromise;
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ by: 'davi' });
    expect(await store.listSignalWaiters('go')).toEqual([]); // its own waiter row was cleaned up
  });

  it('in-process, bounded waitForSignal: the same window is closed within the timeout arm', async () => {
    const now = 1000;
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForSignal<{ by: string }>('go', { timeoutMs: 60_000 }),
    );

    const gate = store.arm('beforePutSignalWaiter');
    const resultPromise = startRun(engine, 'approval', {}, 'r1');
    await gate.reached;

    const delivered = await engine.signal('go', { by: 'ana' });
    expect(delivered).toBeNull();

    gate.release();
    const result = await resultPromise;
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ by: 'ana' });
    expect(await store.listSignalWaiters('go')).toEqual([]);
  });

  it('remote waitSignal command path: the same window is closed for a polyglot (Python-style) workflow', async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.registerRemote('approval', '1', {
      group: 'py-workflows',
      executor: waitSignalExecutor('go'),
    });

    const gate = store.arm('beforePutSignalWaiter');
    await engine.start('approval', {}, 'r1');
    await gate.reached; // the turn is paused RIGHT BEFORE the remote waitSignal command registers.

    const delivered = await engine.signal('go', { by: 'remote' });
    expect(delivered).toBeNull();

    // Release: the command registers, re-checks the buffer, finds our payload, writes the resolving
    // checkpoint, and re-drives on a macrotask (the remote path suspends THIS turn first, then a
    // deferred `setTimeout` resume completes it on the next one — by design, so the resume that found
    // the buffer never races its own still-unwinding turn) — so wait for that second turn to land
    // instead of a one-shot `waitForRun`, which would settle on the intermediate `suspended` state.
    gate.release();
    await waitUntil(async () => (await store.getRun('r1'))?.status === 'completed');
    const result = await store.getRun('r1');
    expect(result?.output).toEqual({ by: 'remote' });
    expect(await store.listSignalWaiters('go')).toEqual([]);
  });

  it('remote waitSignal command: a pre-existing buffer resolves the FIRST check without ever registering a waiter', async () => {
    // This is what closes the entity-loop misdelivery hazard: registering UNCONDITIONALLY before the
    // first check (instead of only on a miss) would expose a "this turn is about to self-resolve"
    // waiter row to a concurrent signal for a token a polyglot entity loop reuses across iterations —
    // which could steal it via engine.signal's plain takeSignalWaiter and misdeliver. Checking first
    // means a turn that already has its answer buffered never touches the waiter table at all.
    const store = new InMemoryStateStore();
    let putCalls = 0;
    const originalPut = store.putSignalWaiter.bind(store);
    store.putSignalWaiter = async (waiter) => {
      putCalls += 1;
      return originalPut(waiter);
    };
    const engine = new WorkflowEngine({ store });
    engine.registerRemote('approval', '1', {
      group: 'py-workflows',
      executor: waitSignalExecutor('go'),
    });

    await store.bufferSignal('go', { by: 'preexisting' });
    await engine.start('approval', {}, 'r1');
    await waitUntil(async () => (await store.getRun('r1'))?.status === 'completed');

    expect(putCalls).toBe(0); // never registered — nothing was ever there to steal
    const result = await store.getRun('r1');
    expect(result?.output).toEqual({ by: 'preexisting' });
  });

  it("mirror-image window: a waiter registers between engine.signal's take-miss and its buffer write", async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) => ctx.waitForSignal<{ by: string }>('go'));

    // signal() misses (no waiter yet), then pauses RIGHT BEFORE it buffers the payload.
    const gate = store.arm('beforeBufferSignal');
    const signalPromise = engine.signal('go', { by: 'gustavo' });
    await gate.reached;

    // The waiter registers (and, since nothing is buffered yet at its own re-check, suspends) WHILE
    // engine.signal is paused mid-delivery. Fire-and-forget: `startRun`'s one-shot `waitForRun` would
    // settle on this intermediate `suspended` state, before the reclaim below ever lands.
    await engine.start('approval', {}, 'r1');
    await waitUntil(async () => (await store.listSignalWaiters('go')).length > 0);

    // Release: engine.signal proceeds to buffer, then re-checks for a late waiter — finds the one that
    // registered in the window — and reclaims + delivers instead of leaving both rows stranded.
    gate.release();
    const signalResult = await signalPromise;
    expect(signalResult?.status).toBe('completed');
    expect(signalResult?.output).toEqual({ by: 'gustavo' });
    const result = await store.getRun('r1');
    expect(result?.status).toBe('completed');
    expect(result?.output).toEqual({ by: 'gustavo' });
    expect(await store.listSignalWaiters('go')).toEqual([]);
  });

  it('reconcile sweep: a stranded buffer + waiter (crash between the two ops) pairs on the next due-timer sweep', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('approval', '1', async (ctx) => ctx.waitForSignal<{ by: string }>('go'));

    const started = await startRun(engine, 'approval', {}, 'r1');
    expect(started.status).toBe('suspended'); // parked on the waiter; nothing buffered yet

    // Simulate the crash: a signal payload lands in the buffer directly (as if the process crashed
    // between a signal's take-miss and its own re-check, or the waiter's put and its own re-check —
    // either way, both rows now sit in the store with nothing left to pair them) WITHOUT going
    // through the normal engine.signal/waitForSignal pairing machinery.
    await store.bufferSignal('go', { by: 'crash-survivor' });
    expect((await store.listSignalWaiters('go')).length).toBe(1); // still stranded, unpaired

    const run = await store.getRun('r1');
    now = (run?.wakeAt ?? 0) + 1; // past the reconcileMs fallback wakeAt this suspend carries
    const results = await engine.resumeDueTimers(now);

    const settled = results.find((r) => r.runId === 'r1');
    expect(settled?.status).toBe('completed');
    expect(settled?.output).toEqual({ by: 'crash-survivor' });
    expect(await store.listSignalWaiters('go')).toEqual([]); // paired and cleaned up, not left stranded
  });

  it("regression: a timed-out wait removes only its OWN waiter row, never a different run's on the same token", async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('approve', '1', async (ctx) => {
      try {
        return await ctx.waitForSignal('go', { timeoutMs: 5000 });
      } catch (e) {
        if (e instanceof SignalTimeoutError) return 'timed-out';
        throw e;
      }
    });

    const first = await startRun(engine, 'approve', {}, 'r1');
    expect(first.status).toBe('suspended');

    // A different run claims the SAME token afterward — `token` is the store's primary key, so this
    // REPLACES r1's row. This is the exact scenario `removeSignalWaiter`'s exact match protects
    // against: r1's stale cleanup on timeout must not delete r2's live registration.
    await store.putSignalWaiter({ token: 'go', runId: 'r2', seq: 9 });

    now = 7000; // past r1's 6000ms deadline
    await engine.resumeDueTimers(now);

    const r1 = await store.getRun('r1');
    expect(r1?.status).toBe('completed');
    expect(r1?.output).toBe('timed-out');

    // r2's waiter survived r1's timeout cleanup untouched.
    const waiters = await store.listSignalWaiters('go');
    expect(waiters).toEqual([{ token: 'go', runId: 'r2', seq: 9 }]);
  });
});
