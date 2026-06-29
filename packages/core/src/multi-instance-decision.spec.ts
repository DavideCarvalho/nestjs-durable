import { WorkflowEngine } from './engine';
import type { WorkflowDecision, WorkflowRun, WorkflowTask } from './interfaces';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { PointToPointDecisionTransport } from './testing/point-to-point-decision-transport';

/**
 * REPRODUCES the multi-instance workflow-turn DECISION-DROP bug.
 *
 * Two `WorkflowEngine` instances ("two pods") share ONE `InMemoryStateStore` ("the DB") and ONE
 * `PointToPointDecisionTransport` ("the broker"). An in-process parent `pipeline` awaits a child of the
 * REMOTE `processing` workflow, which fans out a `gather_calls` of N remote `call`s. The parent's turn
 * is dispatched by engine A, but the broker is point-to-point: it hands the turn's DECISION to engine
 * B (a NON-dispatcher).
 *
 * Before the fix, the dispatcher (A) awaited the decision on an in-memory `pending` map that only A
 * held; a decision delivered to B was DROPPED, so the child stuck `suspended` with every gather step
 * `completed` and the parent never finished. After the fix, `onDecision` → `completeRemoteDecision`
 * applies the decision DURABLY by run id on whatever instance consumes it, so engine B completes the
 * turn engine A dispatched.
 *
 * This test asserts the CORRECT (post-fix) behaviour: BOTH the child and the parent reach `completed`,
 * with the child's gather checkpoints all `completed`. It FAILS against the unpatched engine (the run
 * sticks) and PASSES after the fix.
 */

const N = 5;
const GROUP = 'processing';

/** The Python `processing` `@workflow` stand-in: replay its `gather_calls([...])` fan over the turn's
 *  history — emit any leaf `call` still absent, complete once all N results are in. Same shape as the
 *  `fanCallExecutor` in gather-calls.spec.ts, but driven from a dispatched {@link WorkflowTask}. */
function processingWorker(task: WorkflowTask): WorkflowDecision {
  const seen = new Set(task.history.map((event) => event.seq));
  const base = { taskId: task.taskId, runId: task.runId } as const;
  const commands = Array.from({ length: N }, (_, seq) => seq)
    .filter((seq) => !seen.has(seq))
    .map((seq) => ({
      kind: 'call' as const,
      seq,
      name: `leaf_${seq}`,
      group: 'steps',
      input: { i: seq },
      parallelGroup: 'gather:0',
    }));
  if (commands.length > 0) return { ...base, status: 'continue', commands };
  const outputs = Array.from(
    { length: N },
    (_, seq) => task.history.find((event) => event.seq === seq)?.output,
  );
  return { ...base, status: 'completed', commands: [], output: { outputs } };
}

/** Poll until terminal (or give up). Returns the run regardless so the test can assert a stuck state
 *  rather than hang — a dropped decision leaves the run non-terminal forever. */
async function settle(store: InMemoryStateStore, runId: string, max = 600): Promise<WorkflowRun> {
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

describe('REGRESSION: multi-instance workflow-turn decision drop', () => {
  it('two engines on one broker + store: in-process parent → remote gather_calls child both COMPLETE', async () => {
    const store = new InMemoryStateStore();
    const transport = new PointToPointDecisionTransport();
    // Staggered leaf step handlers (results land at different times → a real partial-resume race).
    for (let i = 0; i < N; i += 1) {
      transport.handle(`leaf_${i}`, async (input: { i: number }) => {
        for (let t = 0; t <= input.i; t += 1) await new Promise((resolve) => setImmediate(resolve));
        return { r: input.i };
      });
    }
    transport.serveWorkflow(processingWorker);

    // TWO engines = two pods sharing ONE store (the DB) + ONE transport (the broker). Each engine
    // registers its own onResult/onDecision handler on the shared transport at construction, so the
    // broker has two point-to-point consumers to choose between.
    function makeEngine(): WorkflowEngine {
      const engine = new WorkflowEngine({ store, transport, remoteAdvanceSilenceMs: 150 });
      // Parent is IN-PROCESS (like flip's pipeline.workflow.ts) and awaits a child of the REMOTE
      // `processing` workflow by name.
      engine.register('pipeline', '1', async (ctx) => {
        const child = await ctx.child<{ outputs: unknown[] }>('processing', { n: N });
        return { fromChild: child };
      });
      // `processing` is REMOTE: a broker-backed RemoteWorkflowExecutor dispatches the turn over the
      // transport and the decision comes back via onDecision — the exact path the bug lives on.
      engine.registerRemote('processing', '1', {
        group: GROUP,
        executor: new RemoteWorkflowExecutor(transport, GROUP),
      });
      return engine;
    }
    const engineA = makeEngine(); // dispatcher (decision consumer index 0)
    makeEngine(); // engineB — the NON-dispatcher (decision consumer index 1) the broker routes to

    // The run starts (and is driven) on engine A, but every workflow-turn decision is delivered to B.
    await engineA.start('pipeline', { n: N }, 'run1');
    const parent = await settle(store, 'run1');
    const child = await store.getRun('run1.child.0');

    if (parent.status !== 'completed' || child?.status !== 'completed') {
      // Diagnostic for the unpatched (stuck) reproduction.
      // eslint-disable-next-line no-console
      console.log('STUCK parent=', parent.status, 'child=', child?.status);
    }

    // Post-fix: the non-dispatcher applied the dispatcher's turn durably, so both complete.
    expect(child?.status).toBe('completed');
    expect(parent.status).toBe('completed');
    expect(parent.output).toEqual({
      fromChild: { outputs: [{ r: 0 }, { r: 1 }, { r: 2 }, { r: 3 }, { r: 4 }] },
    });

    // Every gathered call checkpoint resolved (these complete even in the stuck case — the bug is the
    // FINAL decision being dropped, leaving the run suspended with all gather steps already done).
    const checkpoints = await store.listCheckpoints('run1.child.0');
    for (let seq = 0; seq < N; seq += 1) {
      const checkpoint = checkpoints.find((entry) => entry.seq === seq);
      expect(checkpoint?.status).toBe('completed');
    }
  });
});
