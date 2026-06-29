import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from './interfaces';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * REPRODUCES the dispatch/mark RACE inside the multi-instance decision fix.
 *
 * The first fix recorded the awaited turn's `taskId` on the run AFTER calling `executor.dispatch`. In
 * production the worker's reply round-trips the IN-CLUSTER broker (redis + worker, ~10ms) faster than
 * the engine's marker write commits to the REMOTE store (dev RDS, a slower hop) — most visibly for a
 * cached re-drive replay that returns `completed` in under a millisecond. So the decision reached
 * `completeRemoteDecision` BEFORE `awaitingDecisionTaskId` was set, failed the `awaitingDecisionTaskId
 * !== decision.taskId` guard, and was DROPPED — leaving the run stuck `suspended` forever even though
 * the worker had already produced the final decision.
 *
 * This transport delivers the workflow-turn decision SYNCHRONOUSLY from `dispatchWorkflowTask` (awaited
 * inline, before it returns) to model that "reply faster than the marker write" ordering deterministically.
 * The fix is SUSPEND-then-ENQUEUE: the engine generates the `taskId`, writes the marker, and releases
 * the lease BEFORE enqueuing — so the decision can always both match the marker and acquire the lease.
 *
 * Asserts the post-fix behaviour: the remote run COMPLETES. Against the unpatched (mark-after-dispatch)
 * engine the decision is dropped and the run sticks `suspended`.
 */

const GROUP = 'proc';

/** A synchronous-delivery broker: `dispatchWorkflowTask` awaits the engine's `onDecision` inline, so the
 *  decision lands during the engine's `await executor.dispatch(...)` — before a mark-after-dispatch engine
 *  could record the awaited `taskId`. */
class SyncDecisionTransport implements Transport {
  private decisionConsumer?: (decision: WorkflowDecision) => Promise<void>;
  private worker?: (task: WorkflowTask) => WorkflowDecision;

  serveWorkflow(fn: (task: WorkflowTask) => WorkflowDecision): void {
    this.worker = fn;
  }

  async dispatch(_task: RemoteTask): Promise<void> {
    // No remote steps in this test — the workflow completes on its first turn.
  }

  onResult(_handler: (result: StepResult) => Promise<void>): void {}

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    if (!this.worker) throw new Error('no workflow worker registered (serveWorkflow)');
    const decision = this.worker(task);
    // SYNCHRONOUS reply: deliver the decision before returning, racing the engine's marker write. A
    // mark-after-dispatch engine has not yet recorded `awaitingDecisionTaskId` here → it drops this.
    await this.decisionConsumer?.(decision);
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionConsumer = handler;
  }
}

/** Poll until terminal (or give up). Returns the run regardless so the test asserts a stuck state rather
 *  than hang — a dropped decision leaves the run `suspended` forever. */
async function settle(store: InMemoryStateStore, runId: string, max = 400): Promise<WorkflowRun> {
  for (let i = 0; i < max; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} missing`);
  return run;
}

describe('REGRESSION: remote workflow-turn decision arrives before its marker (dispatch/mark race)', () => {
  it('a decision delivered synchronously on dispatch still applies — the remote run COMPLETES', async () => {
    const store = new InMemoryStateStore();
    const transport = new SyncDecisionTransport();
    // The worker replays the turn and returns `completed` immediately (the cached-replay re-drive shape
    // that produces a sub-millisecond decision in production).
    transport.serveWorkflow((task) => ({
      taskId: task.taskId,
      runId: task.runId,
      status: 'completed',
      commands: [],
      output: { ok: true },
    }));

    const engine = new WorkflowEngine({ store, transport, remoteAdvanceSilenceMs: 150 });
    engine.registerRemote('proc', '1', {
      group: GROUP,
      executor: new RemoteWorkflowExecutor(transport, GROUP),
    });

    await engine.start('proc', {}, 'run1');
    const run = await settle(store, 'run1');

    if (run.status !== 'completed') {
      // Diagnostic for the unpatched (stuck) reproduction.
      // eslint-disable-next-line no-console
      console.log('STUCK run=', run.status, 'awaiting=', run.awaitingDecisionTaskId);
    }

    // Post-fix: the marker is written (and the lease freed) before the enqueue, so the synchronous
    // decision matches and applies.
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ ok: true });
    expect(run.awaitingDecisionTaskId).toBeUndefined();
  });
});
