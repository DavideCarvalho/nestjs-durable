import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  RemoteTask,
  RunStatus,
  StepCheckpoint,
  StepResult,
  Transport,
  WorkflowRun,
} from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A turn must not give up its run lease before the state it settled on is durable, and the orphan
 * sweep must not act on a run state it read before it held that lease.
 *
 * Observed in flip's e2e suite (a durable `agent.run` chat turn, the LLM call a dispatched `ctx.step`
 * served in-process by a fake model that answers in a couple of milliseconds): the turn that
 * dispatched the step released its lease while the run row still read `running`, because
 * `runExecutionTurn` did `return this.settleRun(...)` inside `try … finally { releaseRunLock }` — the
 * `finally` runs as soon as the `return` expression is evaluated, not once the settle has been
 * written. In that window the 1-second `recoverIncomplete` sweep acquired the free lease, saw
 * `running` with no pending remote step (the fast result had already landed), took the run for a
 * crashed orphan, counted a recovery attempt, rewrote it to `pending` and re-enqueued it — so a SECOND
 * execution replayed the run alongside the one the result had legitimately resumed. The two raced
 * through the same checkpoint positions (a local `persist:run:fail` step written over the other's
 * dispatched `AgentRunSteps.tool` at the same seq), and the chat turn either failed or never ended.
 * Recorded trace (store writes, in order):
 *
 *   saveCheckpoint  run:14 AgentRunSteps.llm pending      (turn A dispatches)
 *   releaseRunLock  run                                   (A's `finally` — status still `running`)
 *   tryLockRun      run -> true                           (recoverIncomplete)
 *   updateRun       run {status: suspended}               (A's settle, AFTER its own release)
 *   saveCheckpoint  run:14 AgentRunSteps.llm completed    (the result lands; resume B starts)
 *   updateRun       run {recoveryAttempts: 1}             (recovery: "orphan")
 *   updateRun       run {status: pending} + runOne        (recovery re-enqueues: execution C)
 */

const PING = 'ext.ping';

/** Records dispatches; results are delivered explicitly by the test. */
class ManualTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  private result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
  async complete(task: RemoteTask, output: unknown = { pong: true }): Promise<void> {
    await this.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output,
    });
  }
}

/** Remembers the run's persisted status at every lease release. */
class ReleaseAuditStore extends InMemoryStateStore {
  readonly statusAtRelease: RunStatus[] = [];
  override async releaseRunLock(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (run) this.statusAtRelease.push(run.status);
    return super.releaseRunLock(runId);
  }
}

describe('a turn settles its run before it releases the lease', () => {
  it('never releases the lease while the run still reads `running`', async () => {
    const store = new ReleaseAuditStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({ store, transports: [{ id: 't', transport }] });
    engine.register('wf', '1', async (ctx) => {
      const r = await ctx.step<{ pong: boolean }>(PING, {});
      return r.pong;
    });

    // First turn: pending -> running -> dispatches the step -> suspends.
    await startRun(engine, 'wf', {}, 'r1');
    expect((await store.getRun('r1'))?.status).toBe('suspended');
    // Every release saw the settled state, never the `running` the turn was executing under.
    expect(store.statusAtRelease).not.toContain('running');

    // Second turn (resumed by the result) runs to completion — same rule on the terminal settle.
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    await transport.complete(task);
    await engine.waitForRun('r1');
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(store.statusAtRelease).not.toContain('running');
  });
});

describe('recoverIncomplete acts on the run it LOCKED, not the one it listed', () => {
  /** A store whose `listIncompleteRuns` answers from a snapshot taken earlier — what a sweep holds
   *  between its SELECT and the `tryLockRun` of each row, while the run moves on underneath it. */
  class StaleListingStore extends InMemoryStateStore {
    staleListing: WorkflowRun[] | undefined;
    override async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
      return this.staleListing ?? super.listIncompleteRuns(namespace);
    }
  }

  it('does not resurrect a run that settled between the listing and the lease', async () => {
    const store = new StaleListingStore();
    const transport = new ManualTransport();
    const dispatchedRuns: string[] = [];
    let executions = 0;
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      runDispatcher: { dispatch: (runId: string) => void dispatchedRuns.push(runId) },
    });
    engine.register('wf', '1', async (ctx) => {
      executions += 1;
      const r = await ctx.step<{ pong: boolean }>(PING, {});
      return r.pong;
    });

    // The sweep lists the run while its first turn is executing it (`running`)…
    await store.createRun({
      id: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const listed = await store.listIncompleteRuns();
    expect(listed.map((r) => r.status)).toEqual(['running']);
    store.staleListing = listed;

    // …and by the time it takes the lease, that turn suspended on its step and the (fast) result
    // resumed the run to completion.
    await engine.runOne('r1');
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    await transport.complete(task);
    await engine.waitForRun('r1');
    expect((await store.getRun('r1'))?.status).toBe('completed');
    const executionsBeforeSweep = executions;

    await engine.recoverIncomplete();

    // Recovery must see the run as it is NOW: nothing to recover. Before the fix it trusted the
    // listed `running`, found no pending remote step, counted an attempt, rewrote the COMPLETED run
    // to `pending` and re-enqueued it for a second execution.
    const after = await store.getRun('r1');
    expect(after?.status).toBe('completed');
    expect(after?.recoveryAttempts ?? 0).toBe(0);
    expect(dispatchedRuns).toEqual([]);
    expect(executions).toBe(executionsBeforeSweep);
    // …and it does not keep the lease it took just to look.
    expect(after?.lockedBy).toBeUndefined();
  });

  it('still recovers a genuinely orphaned run (a turn that died holding `running`)', async () => {
    const store = new StaleListingStore();
    const dispatchedRuns: string[] = [];
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: (runId: string) => void dispatchedRuns.push(runId) },
    });
    engine.register('wf', '1', async () => 'done');
    await store.createRun({
      id: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await engine.recoverIncomplete();

    const after = await store.getRun('r1');
    expect(after?.status).toBe('pending');
    expect(after?.recoveryAttempts).toBe(1);
    expect(dispatchedRuns).toEqual(['r1']);
  });
});

describe("a replay's stale view of a remote step never overwrites its landed result", () => {
  /**
   * The lost-dispatch lease (`remoteRedispatchMs`) is stamped by a replay that finds its step still
   * `pending`. That replay reads the step from the snapshot it took when it STARTED — so a result
   * landing after the snapshot is invisible to it, and stamping `{ ...snapshot, wakeAt }` wrote the
   * stale `pending` row back over the `completed` one: the result was gone, and the run parked on a
   * lease an hour out.
   */
  class SnapshotRaceStore extends InMemoryStateStore {
    /** Called right after a `listCheckpoints` snapshot is taken for `runId`, once. */
    afterSnapshot?: (() => Promise<void>) | undefined;
    override async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
      const snapshot = await super.listCheckpoints(runId);
      const hook = this.afterSnapshot;
      if (hook) {
        this.afterSnapshot = undefined;
        await hook();
      }
      return snapshot;
    }
  }

  it('re-reads the step before stamping its lease, and replays the result instead', async () => {
    let now = 1_000_000;
    const store = new SnapshotRaceStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 't', transport }],
      clock: () => now,
      reconcileMs: 0,
      remoteRedispatchMs: 60 * 60_000,
    });
    engine.register('wf', '1', async (ctx) => {
      const r = await ctx.step<{ pong: boolean }>(PING, {});
      return r.pong;
    });

    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0];
    if (!task) throw new Error('expected a dispatched task');
    const seq = task.seq;
    expect((await store.getCheckpoint('r1', seq))?.status).toBe('pending');

    // A replay takes its snapshot (step still `pending`); the result lands right after. The run is
    // held by another owner, so the result's own resume is a no-op — the replay is the only turn.
    store.afterSnapshot = async () => {
      const run = await store.getRun('r1');
      if (run) run.lockedBy = 'someone-else';
      await store.saveCheckpoint({
        ...((await store.getCheckpoint('r1', seq)) as StepCheckpoint),
        status: 'completed',
        output: { pong: true },
      });
      if (run) run.lockedBy = undefined;
    };
    now += 1_000;
    await engine.runOne('r1');

    const cp = await store.getCheckpoint('r1', seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ pong: true });
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe(true);
    expect(transport.dispatched).toHaveLength(1);
  });
});
