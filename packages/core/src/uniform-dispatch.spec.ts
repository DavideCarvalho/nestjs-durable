import { stepCheckpoint } from './checkpoints';
import { WorkflowEngine } from './engine';
import type {
  HistoryEvent,
  StepError,
  WorkflowCommand,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
} from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

// ---------------------------------------------------------------------------
// Uniform dispatch (Phase 2): a LOCAL `@Workflow` TS body served via the app's OWN group.
//
// `register(name, version, fn, { group, executor })` keeps `fn` (the body) AND routes the run's
// turns through `executor` — the SAME dispatch path a Python workflow takes (`registerRemote`),
// except the body is a retained TS `fn` an IN-APP worker fetches by name (`engine.workflowBody`)
// and replays. This file proves "one app, both roles, own group": ONE engine owns the run AND
// (through the executor) runs an in-process worker that executes the body — end-to-end, across a
// suspend/resume, under recovery, and under cancel.
//
// The in-process worker below is a faithful TEST DOUBLE of the production worker (`@dudousxd/
// durable-worker`'s `WorkflowWorker`, which core cannot import without a dependency cycle): it
// replays a body against a recording context and returns a `WorkflowDecision`. It supports the ops
// these proofs use (`step`, `sleep`); the production worker covers the full surface. The body it
// runs targets THIS worker's context — a different runtime than core's `WorkflowCtx`, exactly as a
// Python body targets the Python runtime — so the engine never invokes it inline (it dispatches).
// ---------------------------------------------------------------------------

/** Thrown by the recording context's `sleep` to unwind the turn into a `continue` decision (the run
 *  suspends on a durable timer; the next turn replays past the now-elapsed timer in history). */
const SUSPEND = Symbol('suspend');
/** Thrown when a replayed history event for a step is a failure the body did not catch. */
class StepFailed extends Error {
  constructor(readonly stepError: StepError) {
    super(stepError.message);
  }
}

/** The minimal worker-side replay context: deterministic seq numbering, replay-from-history, and a
 *  command buffer — the same contract as the production `WorkflowContext`, scoped to `step`/`sleep`. */
class RecordingCtx {
  private seq = 0;
  private readonly history: Map<number, HistoryEvent>;
  readonly commands: WorkflowCommand[] = [];

  constructor(history: HistoryEvent[]) {
    this.history = new Map(history.map((event) => [event.seq, event]));
  }

  /** A local durable step: replay its recorded result if present, else run the body inline this turn
   *  and record it (steps never suspend the turn — only sleeps/calls/signals/children do). */
  async step<TOutput>(name: string, body: () => Promise<TOutput> | TOutput): Promise<TOutput> {
    const seq = this.seq;
    this.seq += 1;
    const replayed = this.history.get(seq);
    if (replayed) {
      if (replayed.error) throw new StepFailed(replayed.error);
      return replayed.output as TOutput;
    }
    const output = await body();
    this.commands.push({ kind: 'recordStep', seq, name, output });
    return output;
  }

  /** A durable sleep: returns immediately when the timer has already elapsed (in history), else emits
   *  a `sleep` command and unwinds the turn so the engine schedules the timer and suspends the run. */
  async sleep(ms: number): Promise<void> {
    const seq = this.seq;
    this.seq += 1;
    if (this.history.has(seq)) return;
    this.commands.push({ kind: 'sleep', seq, ms });
    throw SUSPEND;
  }
}

/** The body shape the in-process worker runs — targets {@link RecordingCtx}, NOT core's `WorkflowCtx`
 *  (the worker runtime is intentionally separate, like the Python runtime). */
type WorkerBody = (ctx: RecordingCtx, input: unknown) => Promise<unknown>;
/** `engine.register`'s `fn` parameter type (core's un-exported `WorkflowFn`), derived so a worker body
 *  can be registered without an `any`. The engine never calls it for a group-served workflow — it
 *  dispatches — so the ctx-runtime mismatch is sound; the cast records that the body is worker-owned. */
type RegisterFn = Parameters<WorkflowEngine['register']>[2];
const asRegisterFn = (body: WorkerBody): RegisterFn => body as unknown as RegisterFn;

/**
 * An in-process {@link WorkflowExecutor}: it "loops the task back" to an in-app worker that fetches
 * the body from THIS engine by name and replays it into a decision — the co-located engine+worker
 * the uniform-dispatch model is built on. `advances` counts turns so a test can prove the run was
 * DISPATCHED (not run inline).
 */
function inProcessExecutor(engine: WorkflowEngine): WorkflowExecutor & { advances: number } {
  const executor = {
    advances: 0,
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      executor.advances += 1;
      const base = { taskId: `${run.id}:${executor.advances}`, runId: run.id } as const;
      const body = engine.workflowBody(run.workflow, run.workflowVersion);
      if (!body) {
        return { ...base, status: 'failed', commands: [], error: { message: 'no body' } };
      }
      const ctx = new RecordingCtx(history);
      try {
        const output = await (body as unknown as WorkerBody)(ctx, run.input);
        return { ...base, status: 'completed', commands: ctx.commands, output };
      } catch (err) {
        if (err === SUSPEND) return { ...base, status: 'continue', commands: ctx.commands };
        if (err instanceof StepFailed) {
          return { ...base, status: 'failed', commands: ctx.commands, error: err.stepError };
        }
        return {
          ...base,
          status: 'failed',
          commands: ctx.commands,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
  return executor;
}

/** Poll the store until `runId` leaves an in-flight state (the executor resolves on a microtask). */
async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('uniform dispatch — a local @Workflow served via its own group', () => {
  it('dispatches a group-served body end-to-end and the awaiter gets its output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const executor = inProcessExecutor(engine);

    let bodyRuns = 0;
    engine.register(
      'greet',
      '1',
      asRegisterFn(async (ctx, input) => {
        const greeting = await ctx.step('compose', () => {
          bodyRuns += 1;
          return `hello ${input as string}`;
        });
        return { greeting };
      }),
      { group: 'app', executor },
    );

    const result = await startRun(engine, 'greet', 'davi', 'g1');
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ greeting: 'hello davi' });
    // The run was DISPATCHED to the in-app worker, not run inline by the engine.
    expect(executor.advances).toBeGreaterThan(0);
    expect(bodyRuns).toBe(1);

    // The step the worker ran is persisted by the engine as a local checkpoint (durable + replayable).
    const step = (await store.listCheckpoints('g1')).find((cp) => cp.seq === 0);
    expect(step?.kind).toBe('local');
    expect(step?.status).toBe('completed');
    expect(step?.output).toBe('hello davi');
  });

  it('marks the registration group-served (remote routing) while keeping the body retrievable', () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const executor = inProcessExecutor(engine);

    engine.register(
      'served',
      '1',
      asRegisterFn(async () => 'ok'),
      { group: 'app', executor },
    );
    engine.register(
      'inline',
      '1',
      asRegisterFn(async () => 'ok'),
    );
    engine.registerRemote('python', '1', { group: 'py', executor });

    // A group-served local body IS retrievable for the in-app worker; so is a plain inline one.
    expect(engine.workflowBody('served', '1')).toBeTypeOf('function');
    expect(engine.workflowBody('inline', '1')).toBeTypeOf('function');
    // A body-less remote (Python) hands out no body, and an unknown name is undefined.
    expect(engine.workflowBody('python', '1')).toBeUndefined();
    expect(engine.workflowBody('missing', '1')).toBeUndefined();

    // The group-served group is reported (the engine dispatches to it), alongside the Python group.
    expect(engine.knownGroups().sort()).toEqual(['app', 'py']);
  });

  it('rejects a half-wired group-served registration (group without executor, or vice-versa)', () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const executor = inProcessExecutor(engine);
    expect(() =>
      engine.register(
        'x',
        '1',
        asRegisterFn(async () => 1),
        { group: 'app' },
      ),
    ).toThrow(/BOTH group and executor/);
    expect(() =>
      engine.register(
        'y',
        '1',
        asRegisterFn(async () => 1),
        { executor },
      ),
    ).toThrow(/BOTH group and executor/);
  });

  it('suspends a group-served body on ctx.sleep and resumes it on the timer — body runs once (replay)', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000_000;
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      clock: () => now,
    });
    const executor = inProcessExecutor(engine);

    let stepRuns = 0;
    engine.register(
      'delayed',
      '1',
      asRegisterFn(async (ctx) => {
        const before = await ctx.step('before', () => {
          stepRuns += 1;
          return 'a';
        });
        await ctx.sleep(5);
        return { before, after: 'b' };
      }),
      { group: 'app', executor },
    );

    const started = await startRun(engine, 'delayed', null, 'd1');
    expect(started.status).toBe('suspended');
    expect((await store.getRun('d1'))?.wakeAt).toBe(now + 5);

    now += 1_000_000;
    await engine.resumeDueTimers(now);
    const done = await settle(store, 'd1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ before: 'a', after: 'b' });
    // Determinism: the step before the sleep ran exactly ONCE despite the second turn replaying it.
    expect(stepRuns).toBe(1);
  });

  it('a plain inline parent awaits a group-served child and receives its output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const executor = inProcessExecutor(engine);

    // Child: group-served (dispatched to the app's own group, run by the in-app worker).
    engine.register(
      'double',
      '1',
      asRegisterFn(async (ctx, input) => {
        const out = await ctx.step('double', () => (input as number) * 2);
        return out;
      }),
      { group: 'app', executor },
    );
    // Parent: a plain inline TS workflow (core's `WorkflowCtx`) that awaits the group-served child.
    engine.register('parent', '1', async (ctx) => {
      const fromChild = await ctx.child<number>('double', 21, 'double-run');
      return { fromChild };
    });

    // The parent suspends on the child, the child is dispatched + run by the in-app worker, and on
    // its completion the engine wakes the parent — which replays, reads the child's output, completes.
    await engine.start('parent', null, 'p1');
    const result = await settle(store, 'p1');
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ fromChild: 42 });
    // The child really ran on the dispatch path (its executor advanced + a child run exists).
    expect(executor.advances).toBeGreaterThan(0);
    expect((await store.getRun('double-run'))?.status).toBe('completed');
  });

  it('recovers a crashed group-served run: recoverIncomplete re-drives it to completion via replay', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const executor = inProcessExecutor(engine);

    let firstRuns = 0;
    engine.register(
      'resumable',
      '1',
      asRegisterFn(async (ctx) => {
        const first = await ctx.step('first', () => {
          firstRuns += 1;
          return 1;
        });
        const second = await ctx.step('second', () => 2);
        return { first, second };
      }),
      { group: 'app', executor },
    );

    // Simulate a worker that crashed mid-turn AFTER checkpointing the first step but before settling:
    // the run is left `running` (orphaned, no live lease) with `first`'s result already in history.
    const at = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'resumable',
      workflowVersion: '1',
      status: 'running',
      input: null,
      createdAt: at,
      updatedAt: at,
    });
    await store.saveCheckpoint(
      stepCheckpoint({
        runId: 'r1',
        seq: 0,
        name: 'first',
        kind: 'local',
        status: 'completed',
        output: 1,
        attempts: 1,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      }),
    );

    // Cold-boot recovery re-enqueues the orphaned run; the re-driven turn dispatches to the worker,
    // which replays `first` from history (NOT re-run) and runs only the unfinished `second`.
    const recovered = await engine.recoverIncomplete();
    expect(recovered.some((r) => r.runId === 'r1')).toBe(true);

    const done = await settle(store, 'r1');
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ first: 1, second: 2 });
    // The checkpointed step was NOT re-run on recovery — replay is intact across the crash.
    expect(firstRuns).toBe(0);
  });

  it('cancels a suspended group-served run (and the cascade reaches it like any dispatched run)', async () => {
    const store = new InMemoryStateStore();
    let now = 3_000_000;
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      clock: () => now,
    });
    const executor = inProcessExecutor(engine);

    engine.register(
      'longsleep',
      '1',
      asRegisterFn(async (ctx) => {
        await ctx.step('mark', () => 'started');
        await ctx.sleep(10_000);
        return 'never';
      }),
      { group: 'app', executor },
    );

    const started = await startRun(engine, 'longsleep', null, 'c1');
    expect(started.status).toBe('suspended');

    const cancelled = await engine.cancel('c1');
    expect(cancelled?.status).toBe('cancelled');
    expect((await store.getRun('c1'))?.status).toBe('cancelled');
    // The pre-sleep step's progress is preserved; the run is terminal (a due-timer poll can't revive it).
    now += 1_000_000;
    await engine.resumeDueTimers(now);
    expect((await store.getRun('c1'))?.status).toBe('cancelled');
  });

  it('keeps the default inline fast path: no group means no remote routing and no executor', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const executor = inProcessExecutor(engine);

    engine.register('plain', '1', async (ctx, input) => {
      const out = await ctx.step('inline', async () => (input as number) + 1);
      return out;
    });

    const result = await startRun(engine, 'plain', 41, 'i1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe(42);
    // The inline path never touches a group/executor — uniform dispatch is strictly opt-in.
    expect(executor.advances).toBe(0);
    expect(engine.knownGroups()).toEqual([]);
  });
});
