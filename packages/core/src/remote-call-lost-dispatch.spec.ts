import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { RemoteTask, WorkflowDecision, WorkflowTask } from './interfaces';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { PointToPointDecisionTransport } from './testing/point-to-point-decision-transport';

/**
 * REGRESSION (dev, 2026-09-17): a `gather_calls` fan-out whose worker process is KILLED mid-step
 * (OOM, exit 137) must not orphan the step forever.
 *
 * A polyglot workflow's turn declares its fan-out as `call` commands, and `applyCommands` persists a
 * `pending` checkpoint + dispatches each one. On every later turn the worker's replay RE-EMITS the
 * calls it is still waiting on — the fan-out is only partially settled — and `applyCommands` skips a
 * command whose checkpoint already exists, so an in-flight step is never double-dispatched.
 *
 * That guard has no notion of a LOST job. When the worker is OOM-killed the queued job dies with the
 * process (BullMQ's stalled-check moves it to `failed` and nothing rebuilds a `StepResult` for a
 * non-TS consumer), yet the checkpoint still says `pending` — "out for delivery". The run wakes on
 * the `reconcileMs` sweep, dispatches a turn, the worker re-emits the calls, `applyCommands` skips
 * them all, and the run goes back to sleep. Forever. Observed in production exactly so:
 *
 *     durable_step_checkpoints  status=pending  attempts=1  wakeAt=NULL
 *     enqueuedAt = startedAt = finishedAt = the original dispatch
 *     run: suspended, lockedBy=NULL, wakeAt advancing every 5 minutes, >1h, no retry
 *
 * `attempts` never leaving 1 and `wakeAt` staying NULL are the tells: the `ctx.step`
 * (`callRemote`) path stamps a redispatch deadline on `wakeAt` the first time it sees a pending
 * step and honours `remoteRedispatchMs`; the polyglot `call` path did neither, so the documented
 * self-heal knob simply did not exist for a fan-out.
 *
 * `reconcileMs: 0` disables the orphan sweep so these tests assert the re-drive itself, not the
 * safety net that would eventually wake the run anyway (and still find nothing to do).
 */

const FAN = 3;
const GROUP = 'etl';
const LOST_SEQ = 1;

/** The Python `durable-worker` stand-in, plus the ability to LOSE a dispatched step job — the OOM
 *  kill: the task never reaches a handler, so no result ever comes back. */
class LossyTransport extends PointToPointDecisionTransport {
  readonly dispatched: RemoteTask[] = [];
  /** Step names whose FIRST dispatch is swallowed (the job that died with the worker). */
  readonly loseFirstDispatchOf = new Set<string>();

  override async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
    if (this.loseFirstDispatchOf.has(task.name) && (task.attempt ?? 1) === 1) return;
    await super.dispatch(task);
  }

  attemptsFor(name: string): number {
    return this.dispatched.filter((t) => t.name === name).length;
  }
}

/** A worker that fans out `FAN` calls in one gather and re-emits whatever has not settled yet —
 *  `ctx.gather_calls`' real behaviour on a partial resume. */
function serveGather(transport: LossyTransport, ran: Map<string, number>): void {
  for (let i = 0; i < FAN; i += 1) {
    transport.handle(`leaf_${i}`, async (input: { i: number }) => {
      ran.set(`leaf_${i}`, (ran.get(`leaf_${i}`) ?? 0) + 1);
      return { r: input.i };
    });
  }
  transport.serveWorkflow((task: WorkflowTask): WorkflowDecision => {
    const seen = new Set(task.history.map((event) => event.seq));
    const base = { taskId: task.taskId, runId: task.runId } as const;
    // A failed call raises inside `gather_calls`, so the replay ends the workflow — what the real
    // Python SDK does when the engine gives up on a step it can no longer deliver.
    const failed = task.history.find((event) => event.error);
    if (failed) return { ...base, status: 'failed', commands: [], error: failed.error };
    const missing = Array.from({ length: FAN }, (_, seq) => seq).filter((seq) => !seen.has(seq));
    if (missing.length === 0)
      return { ...base, status: 'completed', commands: [], output: { FAN } };
    return {
      ...base,
      status: 'continue',
      commands: missing.map((seq) => ({
        kind: 'call' as const,
        seq,
        name: `leaf_${seq}`,
        group: 'steps',
        input: { i: seq },
        parallelGroup: 'gather:0',
      })),
    };
  });
}

interface Harness {
  engine: WorkflowEngine;
  store: InMemoryStateStore;
  transport: LossyTransport;
  ran: Map<string, number>;
  now: () => number;
  advance: (ms: number) => void;
  /** One timer-poller tick: what a deployment's `resumeDueTimers` interval does. */
  tick: () => Promise<void>;
}

function harness(
  opts: { remoteRedispatchMs?: number; remoteRedispatchMax?: number } = {},
): Harness {
  let now = 1_000_000;
  const store = new InMemoryStateStore();
  const transport = new LossyTransport();
  const ran = new Map<string, number>();
  serveGather(transport, ran);
  const engine = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    clock: () => now,
    reconcileMs: 0,
    ...opts,
  });
  engine.registerRemote(GROUP, '1', {
    group: GROUP,
    executor: new RemoteWorkflowExecutor(transport, GROUP),
  });
  return {
    engine,
    store,
    transport,
    ran,
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

/** Let the broker's `setImmediate` hops (results, decisions) settle. */
async function drain(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('REGRESSION: a gather_calls step whose worker was OOM-killed is re-driven', () => {
  it('reproduces the orphan: the lost step stays pending with attempts=1 and the run never completes', async () => {
    const h = harness(); // no remoteRedispatchMs — the shipped default
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);

    await h.engine.start(GROUP, {}, 'run1');
    await drain();

    // Every turn re-emits the lost call, and every turn skips it: the run is stuck.
    for (let i = 0; i < 5; i += 1) {
      h.advance(600_000);
      await h.tick();
    }

    const run = await h.store.getRun('run1');
    const lost = (await h.store.listCheckpoints('run1')).find((c) => c.seq === LOST_SEQ);
    expect(run?.status).toBe('suspended');
    expect(lost?.status).toBe('pending');
    expect(lost?.attempts).toBe(1);
    expect(h.transport.attemptsFor(`leaf_${LOST_SEQ}`)).toBe(1); // never re-dispatched
  });

  it('re-drives the lost step once its lease lapses, and the run completes', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);

    await h.engine.start(GROUP, {}, 'run1');
    await drain();

    // The dispatch stamped a lease on the pending checkpoint, and the run suspended ON it — so the
    // timer poller (not the 5-minute reconcile net) is what brings the run back.
    const leased = (await h.store.listCheckpoints('run1')).find((c) => c.seq === LOST_SEQ);
    expect(leased?.wakeAt).toBe(h.now() + 60_000);
    expect((await h.store.getRun('run1'))?.wakeAt).toBe(h.now() + 60_000);

    // Before the lease lapses: nothing is re-dispatched.
    h.advance(30_000);
    await h.tick();
    expect(h.transport.attemptsFor(`leaf_${LOST_SEQ}`)).toBe(1);

    // Past it: re-dispatched once, the result lands, the run finishes.
    h.advance(31_000);
    await h.tick();
    await drain();

    const run = await h.store.getRun('run1');
    expect(h.transport.attemptsFor(`leaf_${LOST_SEQ}`)).toBe(2);
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ FAN });
  });

  it('re-drives EVERY step the dead worker was holding, in one turn (the incident had four)', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    for (let i = 0; i < FAN; i += 1) h.transport.loseFirstDispatchOf.add(`leaf_${i}`);

    await h.engine.start(GROUP, {}, 'run1');
    await drain();
    expect(h.transport.dispatched).toHaveLength(FAN); // dispatched, all lost with the worker

    h.advance(61_000);
    await h.tick();
    await drain();

    const run = await h.store.getRun('run1');
    for (let i = 0; i < FAN; i += 1) expect(h.transport.attemptsFor(`leaf_${i}`)).toBe(2);
    expect(run?.status).toBe('completed');
  });

  it('does not re-run the siblings that completed before the crash (the checkpoint wins)', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);

    await h.engine.start(GROUP, {}, 'run1');
    await drain();
    h.advance(61_000);
    await h.tick();
    await drain();

    expect((await h.store.getRun('run1'))?.status).toBe('completed');
    for (let i = 0; i < FAN; i += 1) expect(h.ran.get(`leaf_${i}`)).toBe(1);
  });

  it('marks the re-drive on the checkpoint so it reads differently from a normal retry', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);
    const started: Array<{ seq?: number; redispatched?: boolean }> = [];
    h.engine.subscribe((event) => {
      if (event.type === 'step.started') {
        started.push({ seq: event.seq, redispatched: event.redispatched });
      }
    });

    await h.engine.start(GROUP, {}, 'run1');
    await drain();
    const before = (await h.store.listCheckpoints('run1')).find((c) => c.seq === LOST_SEQ);
    expect(before?.events ?? []).toHaveLength(0);

    h.advance(61_000);
    await h.tick();
    await drain();

    // The step's own trail records WHY it ran again — a lost dispatch, not a failure retry.
    const redrive = started.filter((e) => e.redispatched);
    expect(redrive).toEqual([{ seq: LOST_SEQ, redispatched: true }]);
    const cp = (await h.store.listCheckpoints('run1')).find((c) => c.seq === LOST_SEQ);
    expect(cp?.events?.map((e) => e.name)).toEqual(['step.redispatched']);
    expect(cp?.events?.[0]?.level).toBe('warn');
    expect(cp?.events?.[0]?.message).toMatch(/lost/i);
  });

  it('is bounded: past remoteRedispatchMax the step fails the run instead of looping', async () => {
    const h = harness({ remoteRedispatchMs: 60_000, remoteRedispatchMax: 2 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);
    // Lose EVERY dispatch of this step, not just the first — a step nothing will ever deliver.
    h.transport.dispatched.length = 0;
    const lossy = h.transport as unknown as { dispatch: (t: RemoteTask) => Promise<void> };
    const inner = lossy.dispatch.bind(h.transport);
    lossy.dispatch = async (task: RemoteTask) => {
      if (task.name === `leaf_${LOST_SEQ}`) {
        h.transport.dispatched.push(task);
        return;
      }
      await inner(task);
    };

    await h.engine.start(GROUP, {}, 'run1');
    await drain();
    for (let i = 0; i < 8; i += 1) {
      h.advance(61_000);
      await h.tick();
      await drain();
    }

    const run = await h.store.getRun('run1');
    expect(h.transport.attemptsFor(`leaf_${LOST_SEQ}`)).toBeLessThanOrEqual(3); // 1 + max 2 re-drives
    expect(run?.status).toBe('failed');
    expect(JSON.stringify(run?.error)).toMatch(/lost/i);
  });

  it('does NOT re-drive a step a live worker is still holding (its heartbeat renews the lease)', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`); // no result — but the worker is alive

    await h.engine.start(GROUP, {}, 'run1');
    await drain();

    const cp = (await h.store.listCheckpoints('run1')).find((c) => c.seq === LOST_SEQ);
    if (!cp?.stepId) throw new Error('expected a dispatched checkpoint');

    // A worker beating for this step keeps the lease alive across several lapsed windows.
    for (let i = 0; i < 4; i += 1) {
      h.advance(45_000);
      await h.transport.emitHeartbeat({
        runId: 'run1',
        seq: LOST_SEQ,
        stepId: cp.stepId,
        group: `leaf_${LOST_SEQ}`,
      });
      await h.tick();
      expect(h.transport.attemptsFor(`leaf_${LOST_SEQ}`)).toBe(1);
    }

    // The beats stop (the worker dies) — now the lease lapses and the step is re-driven.
    h.advance(61_000);
    await h.tick();
    await drain();
    expect(h.transport.attemptsFor(`leaf_${LOST_SEQ}`)).toBe(2);
  });
});
