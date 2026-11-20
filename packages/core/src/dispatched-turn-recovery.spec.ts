import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  HistoryEvent,
  RunDispatch,
  StateStore,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
  WorkflowTaskState,
} from './interfaces';
import { HANDOFF_SEQ_BASE, handoffName, onErrorRunId } from './on-error';
import { InMemoryRunQueue } from './testing/in-memory-run-queue';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/**
 * A workflow turn dispatched to a worker spends the run's `maxRecoveryAttempts` budget when it is
 * lost, like a crashed inline turn does.
 *
 * A dispatched run waits `suspended` (not `running`) while its turn is on the broker, so crash
 * recovery never saw it: a turn that killed its worker every time was re-dispatched by the timer
 * poller, and redelivered by BullMQ, for ever. A lost turn is one whose re-drive deadline passed with
 * no decision and no heartbeat, whose task a worker did take, judged by an instance that re-drives
 * it. Each counts once; turns lost in a row past the limit dead-letter the run with the same
 * `max_recovery_attempts` ending (and the same `onDead` announcement) as an inline run, and an applied
 * decision starts the budget again.
 */

const WORKFLOW = 'crashy';
const SILENCE_MS = 60_000;
const LEASE_MS = 30_000;
const RUN_ID = 'run1';
const LIMIT = 5;

/** The worker side of the broker: dispatched turns are recorded; decisions and beats are sent by the test. */
class Worker {
  readonly tasks: WorkflowTask[] = [];
  /** What the broker reports for every dispatched task. */
  taskState: WorkflowTaskState = 'taken';
  decide?: (decision: WorkflowDecision) => Promise<void>;
  beat?: (beat: Heartbeat) => Promise<void>;

  async heartbeat(): Promise<void> {
    await this.beat?.({ runId: RUN_ID, seq: 0, group: WORKFLOW });
  }

  /** Answer the newest dispatched turn. */
  async answer(decision: Omit<WorkflowDecision, 'taskId' | 'runId'>): Promise<void> {
    const task = this.tasks.at(-1) as WorkflowTask;
    await this.decide?.({ ...decision, taskId: task.taskId, runId: task.runId });
  }
}

/** Adds the workflow-task half (decisions, run-scoped beats) to a base transport; `held` swallows
 *  run-queue wakes, as a backed-up or lost run queue does. */
function withWorker(base: Transport, worker: Worker, held: { wakes: boolean }): Transport {
  return {
    ...base,
    dispatch: base.dispatch.bind(base),
    onResult: base.onResult.bind(base),
    ...(base.dispatchRuns
      ? {
          dispatchRuns: async (runs: readonly RunDispatch[], opts) => {
            if (held.wakes) return;
            await base.dispatchRuns?.(runs, opts);
          },
        }
      : {}),
    onHeartbeat(handler) {
      worker.beat = handler;
    },
    async dispatchWorkflowTask(task: WorkflowTask) {
      worker.tasks.push(task);
    },
    onDecision(handler) {
      worker.decide = handler;
    },
  };
}

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function until(check: () => boolean | Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

type Mode = 'resumes due runs itself' | 'hands due runs to the run queue';

interface Options {
  mode?: Mode;
  store?: StateStore;
  worker?: Worker;
  clock?: { now: number };
  reconcileMs?: number;
  register?: boolean;
  unregisteredWorkflowGraceMs?: number;
}

function harness(opts: Options = {}) {
  const mode = opts.mode ?? 'resumes due runs itself';
  // Wall-clock based: the unregistered grace compares the run's `updatedAt` (a real Date) to it.
  const clock = opts.clock ?? { now: Date.now() };
  const store = opts.store ?? new InMemoryStateStore();
  const worker = opts.worker ?? new Worker();
  const held = { wakes: false };
  const queue = new InMemoryRunQueue();
  const base = mode === 'resumes due runs itself' ? new InMemoryTransport() : queue.transport();
  const engine = new WorkflowEngine({
    store,
    transport: withWorker(base, worker, held),
    clock: () => clock.now,
    leaseMs: LEASE_MS,
    reconcileMs: opts.reconcileMs ?? 0,
    remoteAdvanceSilenceMs: SILENCE_MS,
    maxRecoveryAttempts: LIMIT,
    ...(opts.unregisteredWorkflowGraceMs !== undefined
      ? { unregisteredWorkflowGraceMs: opts.unregisteredWorkflowGraceMs }
      : {}),
  });
  if (mode === 'hands due runs to the run queue') engine.consumeRuns();
  if (opts.register !== false) {
    engine.registerRemote(WORKFLOW, '1', {
      group: WORKFLOW,
      executor: {
        async dispatch(run: WorkflowRun, history: HistoryEvent[], taskId: string): Promise<void> {
          worker.tasks.push({
            taskId,
            runId: run.id,
            workflow: run.workflow,
            workflowVersion: run.workflowVersion,
            input: run.input,
            history,
            group: WORKFLOW,
            attempt: 1,
          });
        },
        async taskState(): Promise<WorkflowTaskState> {
          return worker.taskState;
        },
      },
    });
  }
  const dead: WorkflowRun[] = [];
  engine.onDead((run) => dead.push(run));
  return {
    engine,
    store,
    worker,
    clock,
    held,
    dead,
    advance: (ms: number) => {
      clock.now += ms;
    },
    /** One timer-poller tick, then wait for the turns it started (here or off the run queue). */
    tick: async (expectTasks?: number) => {
      await engine.resumeDueTimers(clock.now);
      await drain();
      if (expectTasks !== undefined) await until(() => worker.tasks.length >= expectTasks);
    },
    run: () => store.getRun(RUN_ID),
    attempts: async () => (await store.getRun(RUN_ID))?.recoveryAttempts ?? 0,
  };
}

async function started(opts: Options = {}) {
  const h = harness(opts);
  await h.engine.start(WORKFLOW, {}, RUN_ID);
  await until(() => h.worker.tasks.length === 1);
  return h;
}

describe.each<Mode>(['resumes due runs itself', 'hands due runs to the run queue'])(
  'a dispatched turn that keeps killing its worker (engine %s)',
  (mode) => {
    it('is re-dispatched up to maxRecoveryAttempts times, then dead-lettered like an inline run', async () => {
      const h = await started({ mode });

      for (let lost = 1; lost <= LIMIT; lost += 1) {
        // The worker dies holding the turn: no decision, no more beats. The deadline lapses.
        h.advance(SILENCE_MS + 1);
        await h.tick(lost + 1);
        expect(await h.attempts()).toBe(lost);
        expect((await h.run())?.status).toBe('suspended');
        expect(h.worker.tasks).toHaveLength(lost + 1);
      }

      // One more lost turn is past the limit: the run is dead, and nothing is dispatched again.
      h.advance(SILENCE_MS + 1);
      await h.tick();
      const run = await h.run();
      expect(run?.status).toBe('dead');
      expect(run?.error?.code).toBe('max_recovery_attempts');
      expect(h.worker.tasks).toHaveLength(LIMIT + 1);
      expect(h.dead.map((r) => [r.id, r.status])).toEqual([[RUN_ID, 'dead']]);

      // A late decision from any of the lost turns cannot bring it back.
      await h.worker.answer({ status: 'completed', commands: [], output: 'late' });
      expect((await h.run())?.status).toBe('dead');

      // And later ticks leave it alone.
      h.advance(SILENCE_MS * 10);
      await h.tick();
      expect(h.worker.tasks).toHaveLength(LIMIT + 1);
    });

    it('is not counted while its worker keeps beating, however long the turn runs', async () => {
      const h = await started({ mode });

      for (let i = 0; i < 20; i += 1) {
        h.advance(SILENCE_MS / 2 + 1);
        await h.worker.heartbeat();
        await h.tick();
      }
      expect(h.worker.tasks).toHaveLength(1);
      expect(await h.attempts()).toBe(0);

      await h.worker.answer({ status: 'completed', commands: [], output: 'done' });
      await until(async () => (await h.run())?.status === 'completed');
      expect(await h.attempts()).toBe(0);
    });

    it('is not counted while its task still waits unstarted in the broker, and is once a worker took it', async () => {
      const h = await started({ mode });
      h.worker.taskState = 'queued';

      for (let i = 0; i < 4; i += 1) {
        h.advance(SILENCE_MS + 1);
        await h.tick();
      }
      // A backed-up queue, not a dead worker: nothing counted and nothing dispatched into the backlog.
      expect(await h.attempts()).toBe(0);
      expect(h.worker.tasks).toHaveLength(1);

      // A worker takes it and dies with it: the next lapse counts.
      h.worker.taskState = 'taken';
      h.advance(SILENCE_MS + 1);
      await h.tick(2);
      expect(await h.attempts()).toBe(1);
    });
  },
);

describe('a lost dispatched turn', () => {
  it('counts once while its wake sits in the run queue for several leases', async () => {
    const h = await started({ mode: 'hands due runs to the run queue' });
    h.held.wakes = true;

    h.advance(SILENCE_MS + 1);
    await h.tick();
    // Each lease the claim lapses and the run is handed off again; the turn was still lost once.
    for (let i = 0; i < 8; i += 1) {
      h.advance(LEASE_MS + 1);
      await h.tick();
    }
    expect(await h.attempts()).toBe(1);
    expect((await h.run())?.status).toBe('suspended');
    expect(h.worker.tasks).toHaveLength(1);

    // The wake finally goes through: the turn is re-dispatched, still counted once.
    h.held.wakes = false;
    h.advance(LEASE_MS + 1);
    await h.tick(2);
    expect(await h.attempts()).toBe(1);
  });

  it('is never counted by an instance that cannot resolve the workflow, which still dead-letters it as unregistered', async () => {
    const store = new InMemoryStateStore();
    const worker = new Worker();
    const clock = { now: Date.now() };
    const h = await started({ store, worker, clock });
    const graceMs = 5 * 60_000;
    // A second instance with no registration (another app, or an older deploy) polls the same store.
    const other = harness({
      store,
      worker: new Worker(),
      clock,
      register: false,
      unregisteredWorkflowGraceMs: graceMs,
    });

    // Past the lapsed deadline, once a second, for half the grace: counted nothing.
    h.advance(SILENCE_MS + 1);
    for (let i = 0; i < 150; i += 1) {
      h.advance(1_000);
      await other.tick();
    }
    expect(await h.attempts()).toBe(0);
    expect((await h.run())?.status).toBe('suspended');

    // And its grace clock kept running, so it ends as an unregistered workflow.
    h.advance(graceMs);
    await other.tick();
    const run = await h.run();
    expect(run?.status).toBe('dead');
    expect(run?.error?.code).toBe('workflow_not_registered');
  });

  it('starts the budget again once a decision is applied: lose, complete turns, lose again counts 1', async () => {
    const h = await started();

    h.advance(SILENCE_MS + 1);
    await h.tick(2);
    expect(await h.attempts()).toBe(1);

    // Several healthy turns: each sleeps, then the timer dispatches the next.
    for (let turn = 0; turn < 3; turn += 1) {
      await h.worker.answer({
        status: 'suspended',
        commands: [{ kind: 'sleep', seq: turn, ms: 1_000 }],
      });
      await drain();
      expect(await h.attempts()).toBe(0);
      h.advance(1_001);
      await h.tick(3 + turn);
    }

    // Another lost turn, far from the first: one in a row, not two over the run's life.
    h.advance(SILENCE_MS + 1);
    await h.tick(6);
    expect(await h.attempts()).toBe(1);
  });

  it('spends nothing across healthy turns, recorded steps and timers', async () => {
    const h = await started();

    // Turn 1 records a step's progress and its result, then sleeps: several checkpoint writes.
    await h.worker.answer({
      status: 'suspended',
      commands: [
        { kind: 'recordStep', seq: 0, name: 'progress', output: { pct: 50 } },
        { kind: 'recordStep', seq: 1, name: 'result', output: { pct: 100 } },
        { kind: 'sleep', seq: 2, ms: 1_000 },
      ],
    });
    await drain();
    const sleeping = await h.run();
    expect(sleeping?.status).toBe('suspended');
    expect(sleeping?.awaitingDecisionTaskId).toBeUndefined();

    h.advance(1_001);
    await h.tick(2);
    await h.worker.answer({ status: 'completed', commands: [], output: 'ok' });
    await until(async () => (await h.run())?.status === 'completed');
    expect(await h.attempts()).toBe(0);
    expect(h.worker.tasks).toHaveLength(2);
  });

  it('after an engine restart, is not counted while its worker resumes beating', async () => {
    const store = new InMemoryStateStore();
    const worker = new Worker();
    const clock = { now: Date.now() };
    await started({ store, worker, clock });

    // The engine is down for ten windows; the worker keeps working, but nobody hears its beats.
    clock.now += SILENCE_MS * 10;
    const restarted = harness({ store, worker, clock });

    // The first pass finds a deadline long past, and counts nothing.
    await restarted.tick();
    expect(await restarted.attempts()).toBe(0);
    expect(worker.tasks).toHaveLength(1);

    // The worker's beats now reach the new engine and keep the turn alive.
    for (let i = 0; i < 6; i += 1) {
      restarted.advance(SILENCE_MS / 2 + 1);
      await worker.heartbeat();
      await restarted.tick();
    }
    expect(await restarted.attempts()).toBe(0);
    expect(worker.tasks).toHaveLength(1);

    await worker.answer({ status: 'completed', commands: [], output: 'ok' });
    await until(async () => (await restarted.run())?.status === 'completed');
  });

  it('after an engine restart, is counted once the boot window passes with no beat', async () => {
    const store = new InMemoryStateStore();
    const worker = new Worker();
    const clock = { now: Date.now() };
    await started({ store, worker, clock });

    clock.now += SILENCE_MS * 10;
    const restarted = harness({ store, worker, clock });
    await restarted.tick();
    expect(await restarted.attempts()).toBe(0);

    restarted.advance(SILENCE_MS + 1);
    await restarted.tick(2);
    expect(await restarted.attempts()).toBe(1);
  });

  it('a run that suspends here after an onError handoff drops the old marker, so its reconcile wake is not a lost turn', async () => {
    const h = await started({ reconcileMs: 120_000 });
    // The run handed its failure to an onError handler that is still running.
    const handlerId = onErrorRunId(RUN_ID, 1);
    await h.store.createRun({
      id: handlerId,
      workflow: 'handler',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await h.store.saveCheckpoint({
      runId: RUN_ID,
      seq: HANDOFF_SEQ_BASE,
      name: handoffName(handlerId),
      kind: 'signal',
      stepId: `${RUN_ID}:${HANDOFF_SEQ_BASE}`,
      status: 'running',
      attempts: 0,
    });

    // The turn's deadline lapses and the re-drive follows the handoff, suspending here.
    await h.engine.resume(RUN_ID);
    const parked = await h.run();
    expect(parked?.status).toBe('suspended');
    expect(parked?.awaitingDecisionTaskId).toBeUndefined();

    // Its reconcile wake re-drives the handoff again; nothing is counted.
    for (let i = 0; i < 3; i += 1) {
      h.advance(120_001);
      await h.tick();
    }
    expect(await h.attempts()).toBe(0);
    expect(h.worker.tasks).toHaveLength(1);
  });
});

describe('dead-lettering a lost turn', () => {
  it('never overwrites a cancel that lands while the pass decides', async () => {
    /** Cancels the run the moment the pass writes `dead`, as a concurrent cancel would. */
    class CancelRacingStore extends InMemoryStateStore {
      override async updateRunIf(
        runId: string,
        expected: WorkflowRun['status'][],
        patch: Partial<WorkflowRun>,
      ): Promise<boolean> {
        if (patch.status === 'dead') await super.updateRun(runId, { status: 'cancelled' });
        return super.updateRunIf(runId, expected, patch);
      }
    }
    const store = new CancelRacingStore();
    const h = await started({ store });
    await store.updateRun(RUN_ID, { recoveryAttempts: LIMIT });

    h.advance(SILENCE_MS + 1);
    await h.tick();
    expect((await h.run())?.status).toBe('cancelled');
    expect(h.dead).toEqual([]);
    expect(h.worker.tasks).toHaveLength(1);
  });
});
