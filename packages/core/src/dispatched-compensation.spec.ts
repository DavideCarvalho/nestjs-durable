import { describe, expect, it } from 'vitest';
import { stepCheckpoint } from './checkpoints';
import { WorkflowEngine } from './engine';
import type { StepUndo } from './interfaces';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepConfig,
  type StepRef,
} from './step-name-symbol';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/** Stamp a plain function as a `@Step` reference (mirrors what the `@Step` decorator does in
 *  `@dudousxd/nestjs-durable`, unavailable to core's own tests). */
function stepRef<TInput, TOutput>(name: string, config?: StepConfig): StepRef<TInput, TOutput> {
  const ref = (() => {}) as unknown as StepRef<TInput, TOutput>;
  (ref as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = name;
  if (config) (ref as { [DURABLE_STEP_CONFIG]?: StepConfig })[DURABLE_STEP_CONFIG] = config;
  return ref;
}

/** Pump the microtask queue until `runId` leaves an in-flight (running/pending/suspended) state — a
 *  saga's unwind hops through several suspend/resume round trips (one per dispatched undo), so this
 *  keeps pumping across ALL of them, not just the first. */
async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Pump the microtask queue until `runId` is registered as a signal waiter on `token` — used to
 *  detect a STABLE suspension point (e.g. a `ctx.waitForSignal`) rather than a transient in-flight
 *  dispatch (which also reports `suspended` but for a totally different, soon-to-resolve reason). */
async function settleUntilWaitingOnSignal(store: InMemoryStateStore, runId: string, token: string) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if ((await store.listSignalWaiters(token)).some((w) => w.runId === runId)) return;
  }
  throw new Error(`run ${runId} never waited on signal "${token}"`);
}

describe('dispatched-step saga compensation (ctx.step compensate)', () => {
  it('undoes dispatched + local compensations in strict reverse order, each dispatched undo receiving {input, output} of ITS step', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const undone: string[] = [];
    const received = new Map<string, unknown>();

    const bookFlight = stepRef<{ pax: string }, { bookingId: string }>('flights.book');
    const cancelBooking = stepRef<StepUndo<{ pax: string }, { bookingId: string }>, unknown>(
      'flights.cancel',
    );
    const chargeCard = stepRef<{ amount: number }, { chargeId: string }>('payments.charge');
    const refundCard = stepRef<StepUndo<{ amount: number }, { chargeId: string }>, unknown>(
      'payments.refund',
    );

    transport.handle('flights.book', async (input: { pax: string }) => ({
      bookingId: `bk_${input.pax}`,
    }));
    transport.handle(
      'flights.cancel',
      async (undo: StepUndo<{ pax: string }, { bookingId: string }>) => {
        undone.push('flight');
        received.set('flight', undo);
      },
    );
    transport.handle('payments.charge', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));
    transport.handle(
      'payments.refund',
      async (undo: StepUndo<{ amount: number }, { chargeId: string }>) => {
        undone.push('payment');
        received.set('payment', undo);
      },
    );

    const engine = new WorkflowEngine({ store, transport });
    engine.register('saga', '1', async (ctx) => {
      await ctx.step(bookFlight, { pax: 'davi' }, { compensate: cancelBooking });
      await ctx.localStep('reserve-seat', async () => 'seat-1', {
        compensate: async () => {
          undone.push('seat');
        },
      });
      await ctx.step(chargeCard, { amount: 100 }, { compensate: refundCard });
      throw new Error('shipment failed');
    });

    await startRun(engine, 'saga', {}, 'r1');
    const finished = await settle(store, 'r1');

    expect(finished.status).toBe('failed');
    expect(finished.error?.message).toBe('shipment failed');
    // Registered order was [flight, seat, payment]; the undo runs in STRICT reverse.
    expect(undone).toEqual(['payment', 'seat', 'flight']);
    expect(received.get('flight')).toEqual({
      input: { pax: 'davi' },
      output: { bookingId: 'bk_davi' },
    });
    expect(received.get('payment')).toEqual({
      input: { amount: 100 },
      output: { chargeId: 'ch_100' },
    });

    // Addendum: every undo — local or dispatched — is ALSO checkpointed at a negative seq, in
    // strict unwind order (-1 = first undone), so the saga is visible on the run's timeline exactly
    // like any other step (not just as a lifecycle event).
    const checkpoints = await store.listCheckpoints('r1');
    const negative = checkpoints.filter((cp) => cp.seq < 0).sort((a, b) => b.seq - a.seq);
    expect(negative.map((cp) => ({ seq: cp.seq, name: cp.name, kind: cp.kind }))).toEqual([
      { seq: -1, name: 'compensate:payments.charge', kind: 'remote' },
      { seq: -2, name: 'compensate:reserve-seat', kind: 'local' },
      { seq: -3, name: 'compensate:flights.book', kind: 'remote' },
    ]);
    expect(negative.every((cp) => cp.status === 'completed')).toBe(true);
  });

  it('crash-mid-unwind: an already-resolved compensation (local or dispatched) is skipped on re-drive, and the next one still runs exactly once', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let cancelBookingCalls = 0;
    let localUndoCalls = 0;

    const bookFlight = stepRef<{ pax: string }, { bookingId: string }>('flights.book');
    const cancelBooking = stepRef<StepUndo<{ pax: string }, { bookingId: string }>, unknown>(
      'flights.cancel',
    );
    transport.handle('flights.book', async (input: { pax: string }) => ({
      bookingId: `bk_${input.pax}`,
    }));
    transport.handle('flights.cancel', async () => {
      cancelBookingCalls += 1;
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.register('saga', '1', async (ctx) => {
      // Registered FIRST (undone SECOND): a local compensation.
      await ctx.localStep('reserve', async () => 'seat-1', {
        compensate: async () => {
          localUndoCalls += 1;
        },
      });
      // Registered SECOND (undone FIRST): a dispatched compensation.
      await ctx.step(bookFlight, { pax: 'davi' }, { compensate: cancelBooking });
      throw new Error('boom');
    });

    // Fabricate the crash: the workflow already ran to the point of throwing, and the unwind already
    // resolved its FIRST entry (cancelBooking, undone first) — its checkpoint landed `completed` — but
    // the process died before the re-drive reached the second (local) one. `recoverIncomplete` (called
    // on boot, or by the timer poller) is what re-drives a `running` run whose lease is free.
    const at = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'saga',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: at,
      updatedAt: at,
    });
    await store.saveCheckpoint(
      stepCheckpoint({
        runId: 'r1',
        seq: 0,
        name: 'reserve',
        kind: 'local',
        status: 'completed',
        output: 'seat-1',
        attempts: 1,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      }),
    );
    await store.saveCheckpoint(
      stepCheckpoint({
        runId: 'r1',
        seq: 1,
        name: 'flights.book',
        kind: 'remote',
        status: 'completed',
        input: { pax: 'davi' },
        output: { bookingId: 'bk_davi' },
        attempts: 1,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      }),
    );
    await store.saveCheckpoint(
      stepCheckpoint({
        runId: 'r1',
        seq: -1, // k=0: cancelBooking, undone FIRST — already resolved before the simulated crash
        name: 'compensate:flights.book',
        kind: 'remote',
        status: 'completed',
        input: { input: { pax: 'davi' }, output: { bookingId: 'bk_davi' } },
        attempts: 1,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      }),
    );
    // No checkpoint at seq -2 (the local undo) — it hasn't run yet.

    const recovered = await engine.recoverIncomplete();
    expect(recovered.some((r) => r.runId === 'r1')).toBe(true);

    const finished = await settle(store, 'r1');
    expect(finished.status).toBe('failed');
    expect(finished.error?.message).toBe('boom');
    // The already-completed dispatched undo was NOT re-run...
    expect(cancelBookingCalls).toBe(0);
    // ...but the not-yet-resolved local one still ran, exactly once.
    expect(localUndoCalls).toBe(1);
  });

  it('a dispatched compensation that exhausts its retries is emitted failed, but the rest of the unwind still runs and the run settles failed with the ORIGINAL error', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const localUndone: string[] = [];
    const failures: string[] = [];

    const bookFlight = stepRef<{ pax: string }, { bookingId: string }>('flights.book');
    // Default policy (no @Step-stamped retries) = 1 attempt, so a single failure is exhausted.
    const cancelBooking = stepRef<StepUndo<{ pax: string }, { bookingId: string }>, unknown>(
      'flights.cancel',
    );
    transport.handle('flights.book', async (input: { pax: string }) => ({
      bookingId: `bk_${input.pax}`,
    }));
    transport.handle('flights.cancel', async () => {
      throw new Error('cancellation desk unreachable');
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.subscribe((e) => {
      if (e.type === 'step.failed' && e.name?.startsWith('compensate:')) {
        failures.push(e.name);
      }
    });

    engine.register('saga', '1', async (ctx) => {
      // Registered FIRST (undone SECOND, still runs — proving the unwind doesn't stop at a failure).
      await ctx.localStep('reserve', async () => 'seat-1', {
        compensate: async () => {
          localUndone.push('reserve');
        },
      });
      // Registered SECOND (undone FIRST): its undo permanently fails.
      await ctx.step(bookFlight, { pax: 'davi' }, { compensate: cancelBooking });
      throw new Error('declined');
    });

    await startRun(engine, 'saga', {}, 'r1');
    const finished = await settle(store, 'r1');

    expect(failures).toEqual(['compensate:flights.book']);
    expect(localUndone).toEqual(['reserve']); // the unwind kept going past the failed one
    expect(finished.status).toBe('failed');
    expect(finished.error?.message).toBe('declined'); // the ORIGINAL failure, never masked
  });

  it('cancel({ compensate: true }) dispatches undos in reverse and settles cancelled — staying `cancelling` (not `suspended`) while a dispatched undo is in flight', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const undone: string[] = [];
    let releaseCancelBooking: (() => void) | undefined;

    const bookFlight = stepRef<{ pax: string }, { bookingId: string }>('flights.book');
    const cancelBooking = stepRef<StepUndo<{ pax: string }, { bookingId: string }>, unknown>(
      'flights.cancel',
    );
    transport.handle('flights.book', async (input: { pax: string }) => ({
      bookingId: `bk_${input.pax}`,
    }));
    // Held open until the test explicitly releases it, so we can observe the run mid-unwind.
    transport.handle('flights.cancel', () => {
      undone.push('flight');
      return new Promise<void>((resolve) => {
        releaseCancelBooking = resolve;
      });
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.register('saga', '1', async (ctx) => {
      await ctx.step(bookFlight, { pax: 'davi' }, { compensate: cancelBooking });
      await ctx.localStep('pack', async () => 'p', {
        compensate: async () => {
          undone.push('pack');
        },
      });
      await ctx.waitForSignal('ship');
      return 'done';
    });

    await engine.start('saga', {}, 'r1');
    await settleUntilWaitingOnSignal(store, 'r1', 'ship');
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    await engine.cancel('r1', { compensate: true });
    // `pack` (registered second) is undone FIRST, in-process; `flights.cancel` (registered first) is
    // undone SECOND, dispatched — wait for its handler to be invoked and hold the run open.
    for (let i = 0; i < 200 && releaseCancelBooking === undefined; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(releaseCancelBooking).toBeDefined();
    expect(undone).toEqual(['pack', 'flight']); // reverse of registration order (bookFlight, pack)
    // Invariant: the run stays `cancelling` (not `suspended`) while the dispatched undo is in flight —
    // `waitForRun`/`engine.cancel`'s idempotent re-check/crash-recovery all key off this status.
    expect((await store.getRun('r1'))?.status).toBe('cancelling');

    releaseCancelBooking?.();
    for (let i = 0; i < 200 && (await store.getRun('r1'))?.status !== 'cancelled'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await store.getRun('r1'))?.status).toBe('cancelled');
  });

  it('replays a failed + fully-compensated run cleanly: no NonDeterminismError, no re-dispatch, the same failure', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let bookCalls = 0;
    let cancelCalls = 0;

    const bookFlight = stepRef<{ pax: string }, { bookingId: string }>('flights.book');
    const cancelBooking = stepRef<StepUndo<{ pax: string }, { bookingId: string }>, unknown>(
      'flights.cancel',
    );
    transport.handle('flights.book', async (input: { pax: string }) => {
      bookCalls += 1;
      return { bookingId: `bk_${input.pax}` };
    });
    transport.handle('flights.cancel', async () => {
      cancelCalls += 1;
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.register('saga', '1', async (ctx) => {
      await ctx.step(bookFlight, { pax: 'davi' }, { compensate: cancelBooking });
      throw new Error('shipment failed');
    });

    await startRun(engine, 'saga', {}, 'r1');
    const first = await settle(store, 'r1');
    expect(first.status).toBe('failed');
    expect(bookCalls).toBe(1);
    expect(cancelCalls).toBe(1);

    // A duplicate/late re-drive (`resume` doesn't skip `failed` runs — a real recovery, or a retry,
    // can land here) must replay clean: no NonDeterminismError, no re-dispatch, same outcome.
    const second = await engine.resume('r1');
    expect(second.status).toBe('failed');
    expect(second.error?.message).toBe('shipment failed');
    expect(bookCalls).toBe(1);
    expect(cancelCalls).toBe(1);
  });

  it('mixed: a string-form compensate (cross-runtime, by name) dispatches the undo by name', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let cancelCalls = 0;

    const bookFlight = stepRef<{ pax: string }, { bookingId: string }>('flights.book');
    transport.handle('flights.book', async (input: { pax: string }) => ({
      bookingId: `bk_${input.pax}`,
    }));
    transport.handle('flights.cancel', async (undo: StepUndo<{ pax: string }, unknown>) => {
      cancelCalls += 1;
      expect(undo).toEqual({ input: { pax: 'davi' }, output: { bookingId: 'bk_davi' } });
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.register('saga', '1', async (ctx) => {
      await ctx.step(bookFlight, { pax: 'davi' }, { compensate: 'flights.cancel' });
      throw new Error('shipment failed');
    });

    await startRun(engine, 'saga', {}, 'r1');
    const finished = await settle(store, 'r1');

    expect(finished.status).toBe('failed');
    expect(cancelCalls).toBe(1);
  });
});
