import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  HistoryEvent,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * The RUN-scoped half of the heartbeat-rearm throttle (its step-scoped sibling lives in
 * `remote-call-lost-dispatch.spec.ts`).
 *
 * A run suspended awaiting a dispatched workflow TURN carries that turn's liveness deadline in its own
 * `wakeAt` (`remoteAdvanceSilenceMs`): if neither the decision nor a heartbeat lands before it lapses,
 * the timer poller re-drives the turn. A worker replaying a long turn therefore beats to defend it —
 * every couple of seconds, for as long as the turn runs — and each beat used to cost a durable `getRun`
 * + `updateRun` on the engine side. The throttle is the WINDOW itself: a renewal buys at most one
 * window, so it is only worth a write once the window is half spent, which still leaves a full
 * half-window of headroom before a re-drive could fire.
 */

const WORKFLOW = 'long-turn';
const SILENCE_MS = 60_000;
const RUN_ID = 'run1';

/** A broker stand-in for a worker holding a LONG turn: the dispatched task is recorded and never
 *  answered (the worker is still replaying), so the run stays suspended on its liveness deadline. */
class SilentWorkflowTransport implements Transport {
  readonly tasks: WorkflowTask[] = [];
  private beat?: (beat: Heartbeat) => Promise<void>;

  async dispatch(_task: RemoteTask): Promise<void> {
    throw new Error('no steps are dispatched in this scenario');
  }

  onResult(_handler: (result: StepResult) => Promise<void>): void {}

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.beat = handler;
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.tasks.push(task);
  }

  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}

  /** Deliver one RUN-scoped beat (no `stepId`) — the turn's liveness, not a step's. */
  async emitRunHeartbeat(): Promise<void> {
    await this.beat?.({ runId: RUN_ID, seq: 0, group: 'py-workflows' });
  }
}

/** Counts the durable reads/writes the run row costs, so a hot beat loop can be held to a bounded
 *  number of them instead of one read + one write per beat. The `fail*` switches make the store hostile
 *  one operation at a time, as a store outage does. */
class CountingStore extends InMemoryStateStore {
  reads = 0;
  writes = 0;
  failReads = false;
  failWrites = false;

  override async getRun(runId: string): Promise<WorkflowRun | null> {
    if (runId === RUN_ID) {
      this.reads += 1;
      if (this.failReads) throw new Error('run read is down');
    }
    return super.getRun(runId);
  }

  override async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    if (runId === RUN_ID) {
      this.writes += 1;
      if (this.failWrites) throw new Error('run write is down');
    }
    return super.updateRun(runId, patch);
  }
}

interface Harness {
  engine: WorkflowEngine;
  store: CountingStore;
  transport: SilentWorkflowTransport;
  now: () => number;
  advance: (ms: number) => void;
  /** One timer-poller tick: what a deployment's `resumeDueTimers` interval does. */
  tick: () => Promise<void>;
}

function harness(): Harness {
  let now = 1_000_000;
  const store = new CountingStore();
  const transport = new SilentWorkflowTransport();
  const engine = new WorkflowEngine({
    store,
    transport,
    clock: () => now,
    reconcileMs: 0,
    remoteAdvanceSilenceMs: SILENCE_MS,
  });
  engine.registerRemote(WORKFLOW, '1', {
    group: 'py-workflows',
    executor: {
      // The dispatch path (not `advance`): the turn is enqueued and the run suspends on its deadline,
      // so the rearm is the DURABLE one — there is no in-memory waiter to reset.
      async dispatch(run: WorkflowRun, _history: HistoryEvent[], taskId: string): Promise<void> {
        await transport.dispatchWorkflowTask({
          taskId,
          runId: run.id,
          workflow: run.workflow,
          workflowVersion: run.workflowVersion,
          input: run.input,
          history: [],
          group: 'py-workflows',
          attempt: 1,
        });
      },
    },
  });
  return {
    engine,
    store,
    transport,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    tick: async () => {
      await engine.resumeDueTimers(now);
      await drain();
    },
  };
}

/** Let the engine's deferred hops (the dispatch-and-suspend turn) settle. */
async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("a suspended turn's heartbeat-rearmed deadline", () => {
  it('is renewed by beats, so a worker still replaying the turn is never re-driven', async () => {
    const h = harness();

    await h.engine.start(WORKFLOW, {}, RUN_ID);
    await drain();
    expect(h.transport.tasks).toHaveLength(1);
    expect((await h.store.getRun(RUN_ID))?.wakeAt).toBe(h.now() + SILENCE_MS);

    // A worker beating for this turn keeps the deadline alive across several lapsed windows.
    for (let i = 0; i < 4; i += 1) {
      h.advance(45_000);
      await h.transport.emitRunHeartbeat();
      await h.tick();
      expect(h.transport.tasks).toHaveLength(1); // not re-dispatched
    }

    // The beats stop (the worker died) — now the deadline lapses and the turn IS re-driven.
    h.advance(SILENCE_MS + 1_000);
    await h.tick();
    expect(h.transport.tasks).toHaveLength(2);
  });

  it('renews on a bounded number of writes, not one per beat', async () => {
    const h = harness();

    await h.engine.start(WORKFLOW, {}, RUN_ID);
    await drain();
    const parked = await h.store.getRun(RUN_ID);
    expect(parked?.awaitingDecisionTaskId).toBeDefined();

    // 120 beats across one full window — a worker beating twice a second.
    h.store.reads = 0;
    h.store.writes = 0;
    for (let i = 0; i < 120; i += 1) {
      h.advance(500);
      await h.transport.emitRunHeartbeat();
    }

    // Two half-windows elapsed, so a handful of durable operations — NOT 120 of each. (Observed: 2
    // writes and 3 reads — the cold-map look plus one per renewal. Asserted as a BOUND, not pinned, so
    // a later refactor of the mark is free to cost one more without a spurious failure.)
    expect(h.store.writes).toBeGreaterThanOrEqual(1); // it really did renew
    expect(h.store.writes).toBeLessThanOrEqual(4);
    expect(h.store.reads).toBeLessThanOrEqual(4);

    // And the deadline is genuinely ahead of the clock with headroom — renewed early, never late.
    const renewed = await h.store.getRun(RUN_ID);
    expect(renewed?.wakeAt).toBeGreaterThan(h.now() + SILENCE_MS / 2);
    // Still awaiting the SAME turn: the beats kept it from being re-driven the whole time.
    expect(renewed?.awaitingDecisionTaskId).toBe(parked?.awaitingDecisionTaskId);
    await h.tick();
    expect(h.transport.tasks).toHaveLength(1);
  });

  it('stops tracking a run whose turn has settled, so a stale beat writes nothing', async () => {
    const h = harness();

    await h.engine.start(WORKFLOW, {}, RUN_ID);
    await drain();
    // The turn's decision landed (marker cleared) — a late beat from the finished worker must not
    // resurrect a deadline on the run.
    await h.store.updateRun(RUN_ID, { awaitingDecisionTaskId: undefined, wakeAt: undefined });

    h.store.writes = 0;
    h.advance(SILENCE_MS);
    for (let i = 0; i < 5; i += 1) await h.transport.emitRunHeartbeat();

    expect(h.store.writes).toBe(0);
    expect((await h.store.getRun(RUN_ID))?.wakeAt).toBeUndefined();
  });

  it('a store that throws never rejects out of the rearm, and the next beat still renews', async () => {
    // Same blast radius as the step-lease rearm: this runs in the transport's serial, uncaught beat
    // handler, so neither the read NOR the write may reject out of it. The mark is only advanced once
    // the write commits, so an outage costs one skipped renewal and the next beat retries.
    const h = harness();

    await h.engine.start(WORKFLOW, {}, RUN_ID);
    await drain();
    const deadlineAtDispatch = (await h.store.getRun(RUN_ID))?.wakeAt;
    expect(deadlineAtDispatch).toBe(h.now() + SILENCE_MS);

    // Half the window spent, so each beat below WOULD renew.
    h.advance(SILENCE_MS / 2 + 1_000);

    h.store.failWrites = true;
    await expect(h.transport.emitRunHeartbeat()).resolves.toBeUndefined();
    await expect(h.transport.emitRunHeartbeat()).resolves.toBeUndefined();
    h.store.failWrites = false;
    h.store.failReads = true;
    await expect(h.transport.emitRunHeartbeat()).resolves.toBeUndefined();
    h.store.failReads = false;
    expect((await h.store.getRun(RUN_ID))?.wakeAt).toBe(deadlineAtDispatch); // nothing committed

    // The store is back: the next beat renews, and the turn was never re-driven meanwhile.
    await h.transport.emitRunHeartbeat();
    expect((await h.store.getRun(RUN_ID))?.wakeAt).toBe(h.now() + SILENCE_MS);
    await h.tick();
    expect(h.transport.tasks).toHaveLength(1);
  });
});
