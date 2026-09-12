import { WorkflowEngine } from './engine';
import type { WorkflowDecision, WorkflowRun, WorkflowTask } from './interfaces';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { PointToPointDecisionTransport } from './testing/point-to-point-decision-transport';

/**
 * REGRESSION: a remote workflow turn must not park a run on blocking ops that
 * have ALREADY settled.
 *
 * A remote turn is dispatched SUSPEND-then-ENQUEUE: the engine marks
 * `awaitingDecisionTaskId`, RELEASES the run lease, then enqueues; when the
 * decision returns, `completeRemoteDecision` re-TAKES the lease to apply it.
 * Meanwhile every settling call runs `completeRemoteResult` -> `resume` ->
 * `execute`, and `execute` gives up SILENTLY when the lease is contended:
 *
 *     if (!(await this.store.tryLockRun(...))) {
 *       return { runId: run.id, status: run.status };   // no retry, no reschedule
 *     }
 *
 * So in a `gather_calls` fan-out the LAST call can settle while the decision
 * computed WITHOUT it is being applied. That call's wake is dropped, and the
 * stale decision then parks the run on a `call` that is already complete. Every
 * call is settled, nothing holds the lease, no decision is awaited — and the run
 * sits `suspended` until the `reconcileMs` orphan sweep re-drives it, 5 minutes
 * later.
 *
 * Traced against a real BullMQ + MySQL control plane driving a Python worker,
 * this is the exact sequence, and it stalled 23% of a 7-call fan-out's runs:
 *
 *     DISPATCH_TURN  historySeqs= 0/1/2/3/4/5      <- turn computed without seq 6
 *     RESULT         seq= 6 completed              <- the last call settles
 *     DECISION       continue                      <- decision from the older history
 *     EXECUTE_DROP   lockedBy= undefined           <- seq 6's resume is dropped
 *     PARK           cmds= call:6                  <- parked on an op already done
 *
 * Rather than re-race the scheduler, this test reproduces the STATE that race
 * produces: the worker returns one decision that re-emits a call whose checkpoint
 * has already completed — exactly the `PARK cmds= call:N` above. The engine must
 * notice it has nothing left to wait for and re-drive, instead of parking.
 * `reconcileMs: 0` disables the orphan sweep so the test asserts the wake itself,
 * not the safety net.
 */

const FAN = 3;
const GROUP = 'proc';

/** Counts suspends, so the test can prove the stale turn really DID park the run. */
class SuspendCountingStore extends InMemoryStateStore {
  suspends = 0;

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    if (patch.status === 'suspended') this.suspends += 1;
    return super.updateRun(runId, patch);
  }
}

async function settle(store: InMemoryStateStore, runId: string, max = 200): Promise<WorkflowRun> {
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

describe('REGRESSION: a remote turn parked on already-settled ops must be re-driven', () => {
  it('a stale gather decision does not orphan the run — it COMPLETES without the reconcile sweep', async () => {
    const store = new SuspendCountingStore();
    const transport = new PointToPointDecisionTransport();
    for (let i = 0; i < FAN; i += 1) {
      transport.handle(`leaf_${i}`, async (input: { i: number }) => ({ r: input.i }));
    }

    // One stale decision, delivered on the turn where every call HAS settled: it
    // re-emits the last call, as a turn computed a moment earlier would have. This
    // is the decision the dropped-wake race makes the engine apply.
    let staleServed = false;
    let suspendsWhenStaleServed = -1;
    transport.serveWorkflow((task: WorkflowTask): WorkflowDecision => {
      const seen = new Set(task.history.map((event) => event.seq));
      const base = { taskId: task.taskId, runId: task.runId } as const;
      const missing = Array.from({ length: FAN }, (_, seq) => seq).filter((seq) => !seen.has(seq));

      if (missing.length === 0 && !staleServed) {
        staleServed = true;
        suspendsWhenStaleServed = store.suspends;
        return {
          ...base,
          status: 'continue',
          commands: [
            {
              kind: 'call' as const,
              seq: FAN - 1,
              name: `leaf_${FAN - 1}`,
              group: 'steps',
              input: { i: FAN - 1 },
              parallelGroup: 'gather:0',
            },
          ],
        };
      }
      if (missing.length > 0) {
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
      }
      return { ...base, status: 'completed', commands: [], output: { fan: FAN } };
    });

    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.registerRemote('proc', '1', {
      group: GROUP,
      executor: new RemoteWorkflowExecutor(transport, GROUP),
    });

    await engine.start('proc', {}, 'run1');
    const run = await settle(store, 'run1');
    const checkpoints = await store.listCheckpoints('run1');

    if (run.status !== 'completed') {
      // Diagnostic for the unpatched (orphaned) reproduction — the production state:
      // everything settled, nothing holding it, nothing scheduled to wake it.
      // eslint-disable-next-line no-console
      console.log(
        'ORPHANED status=',
        run.status,
        'awaiting=',
        run.awaitingDecisionTaskId,
        'lockedBy=',
        run.lockedBy,
        'wakeAt=',
        run.wakeAt,
        'checkpoints=',
        checkpoints.map((c) => `${c.seq}:${c.status}`).join(','),
      );
    }

    expect(staleServed).toBe(true);
    // The stale decision must actually have PARKED the run: without this the test would
    // still pass if the engine simply never applied it, which is a different behaviour
    // from recovering out of the parked state.
    expect(store.suspends).toBeGreaterThan(suspendsWhenStaleServed);
    // Every call really did settle — the run had no reason to stay parked.
    expect(checkpoints.filter((c) => c.status === 'completed').length).toBe(FAN);
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ fan: FAN });
  });
});
