import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  HistoryEvent,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from './interfaces';
import { InMemoryRunQueue } from './testing/in-memory-run-queue';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/**
 * A workflow turn dispatched to a worker spends the run's `maxRecoveryAttempts` budget each time it
 * is lost, like a crashed inline turn does.
 *
 * A dispatched run waits `suspended` (not `running`) while its turn is on the broker, so crash
 * recovery never saw it: a turn that killed its worker every time (an out-of-memory body, a native
 * crash) was re-dispatched by the timer poller, and redelivered by BullMQ, for ever. A lost turn is
 * one whose re-drive deadline passed with no decision and no heartbeat; each such lapse now counts,
 * and past the limit the run is dead-lettered with the same `max_recovery_attempts` ending (and the
 * same `onDead` / `run.failed` announcement) as an inline run. A healthy dispatch never counts: a
 * decision clears the awaited turn, and a beating worker keeps pushing the deadline forward.
 */

const WORKFLOW = 'crashy';
const SILENCE_MS = 60_000;
const RUN_ID = 'run1';
const LIMIT = 5;

/** The worker side of the broker: dispatched turns are recorded; decisions and beats are sent by the test. */
class Worker {
  readonly tasks: WorkflowTask[] = [];
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

/** Adds the workflow-task half (decisions, run-scoped beats) to a base transport. */
function withWorker(base: Transport, worker: Worker): Transport {
  return {
    ...base,
    dispatch: base.dispatch.bind(base),
    onResult: base.onResult.bind(base),
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

function harness(mode: Mode) {
  let now = 1_000_000;
  const store = new InMemoryStateStore();
  const worker = new Worker();
  const queue = new InMemoryRunQueue();
  const base = mode === 'resumes due runs itself' ? new InMemoryTransport() : queue.transport();
  const engine = new WorkflowEngine({
    store,
    transport: withWorker(base, worker),
    clock: () => now,
    reconcileMs: 0,
    remoteAdvanceSilenceMs: SILENCE_MS,
    maxRecoveryAttempts: LIMIT,
  });
  if (mode === 'hands due runs to the run queue') engine.consumeRuns();
  engine.registerRemote(WORKFLOW, '1', {
    group: WORKFLOW,
    executor: {
      async dispatch(run: WorkflowRun, history: HistoryEvent[], taskId: string): Promise<void> {
        await worker.tasks.push({
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
    },
  });
  const dead: WorkflowRun[] = [];
  engine.onDead((run) => dead.push(run));
  return {
    engine,
    store,
    worker,
    dead,
    advance: (ms: number) => {
      now += ms;
    },
    /** One timer-poller tick, then wait for the turns it started (here or off the run queue). */
    tick: async (expectTasks?: number) => {
      await engine.resumeDueTimers(now);
      await drain();
      if (expectTasks !== undefined) await until(() => worker.tasks.length >= expectTasks);
    },
    run: () => store.getRun(RUN_ID),
  };
}

describe.each<Mode>(['resumes due runs itself', 'hands due runs to the run queue'])(
  'a dispatched turn that keeps killing its worker (engine %s)',
  (mode) => {
    it('is re-dispatched up to maxRecoveryAttempts times, then dead-lettered like an inline run', async () => {
      const h = harness(mode);
      await h.engine.start(WORKFLOW, {}, RUN_ID);
      await until(() => h.worker.tasks.length === 1);

      for (let lost = 1; lost <= LIMIT; lost += 1) {
        // The worker dies holding the turn: no decision, no more beats. The deadline lapses.
        h.advance(SILENCE_MS + 1);
        await h.tick(lost + 1);
        const run = await h.run();
        expect(run?.recoveryAttempts).toBe(lost);
        expect(run?.status).toBe('suspended');
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
      const h = harness(mode);
      await h.engine.start(WORKFLOW, {}, RUN_ID);
      await until(() => h.worker.tasks.length === 1);

      for (let i = 0; i < 20; i += 1) {
        h.advance(SILENCE_MS / 2 + 1);
        await h.worker.heartbeat();
        await h.tick();
      }
      expect(h.worker.tasks).toHaveLength(1);
      expect((await h.run())?.recoveryAttempts ?? 0).toBe(0);

      await h.worker.answer({ status: 'completed', commands: [], output: 'done' });
      await until(async () => (await h.run())?.status === 'completed');
      expect((await h.run())?.recoveryAttempts ?? 0).toBe(0);
    });
  },
);

describe('a healthy dispatched run', () => {
  it('spends nothing across several turns, recorded steps and timers', async () => {
    const h = harness('resumes due runs itself');
    await h.engine.start(WORKFLOW, {}, RUN_ID);
    await until(() => h.worker.tasks.length === 1);

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

    // The timer fires: a new turn is dispatched (a re-drive with no lost turn behind it).
    h.advance(1_001);
    await h.tick(2);
    expect((await h.run())?.recoveryAttempts ?? 0).toBe(0);

    await h.worker.answer({ status: 'completed', commands: [], output: 'ok' });
    await until(async () => (await h.run())?.status === 'completed');
    expect((await h.run())?.recoveryAttempts ?? 0).toBe(0);
    expect(h.worker.tasks).toHaveLength(2);
  });

  it('a lost turn that is then answered keeps its one counted attempt and completes', async () => {
    const h = harness('resumes due runs itself');
    await h.engine.start(WORKFLOW, {}, RUN_ID);
    await until(() => h.worker.tasks.length === 1);

    h.advance(SILENCE_MS + 1);
    await h.tick(2);
    expect((await h.run())?.recoveryAttempts).toBe(1);

    await h.worker.answer({ status: 'completed', commands: [], output: 'ok' });
    await until(async () => (await h.run())?.status === 'completed');
    expect((await h.run())?.recoveryAttempts).toBe(1);
  });
});
