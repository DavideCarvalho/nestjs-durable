import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

const CHARGE_CARD_STEP_NAME = 'billing.charge-card';

/**
 * This spec LOCKS the existing stateless-replay-per-turn execution model (`engine.ts:2467-2472`):
 * the engine re-invokes the WHOLE workflow body on every turn; a completed `ctx.localStep`/`ctx.step`
 * closure is never re-run — its checkpointed output is returned instead. It is a regression lock,
 * not new behavior — a failure here means the execution-model assumption changed, not that this
 * test is wrong.
 */
describe('replay recovery — stateless-replay-per-turn execution model', () => {
  it('re-invokes the workflow body every turn without re-running a completed step closure, even under a fresh engine instance over the same store', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();

    // Module-level side-effect counter: proves each local step closure runs EXACTLY once across
    // however many turns the workflow body is re-invoked.
    let stepRuns = 0;
    let remoteDispatches = 0;

    transport.handle(CHARGE_CARD_STEP_NAME, async (input: { amount: number }) => {
      remoteDispatches += 1;
      return { chargeId: `ch_${input.amount}` };
    });

    function registerCheckout(engine: WorkflowEngine) {
      engine.register('checkout', '1', async (ctx) => {
        const a = await ctx.localStep('a', async () => {
          stepRuns += 1;
          return 10;
        });
        const charge = await ctx.step<{ chargeId: string }>(CHARGE_CARD_STEP_NAME, { amount: a });
        const b = await ctx.localStep('b', async () => {
          stepRuns += 1;
          return charge.chargeId;
        });
        return b;
      });
    }

    // First "worker": enqueue-only start + a manually-driven turn (no-op dispatcher, mirroring the
    // dispatch-nudge harness) so the test controls exactly when each turn runs.
    const engine1 = new WorkflowEngine({
      store,
      transport,
      instanceId: 'engine1',
      runDispatcher: { dispatch: () => {} },
    });
    registerCheckout(engine1);

    await engine1.start('checkout', {}, 'run1');
    const turn1 = await engine1.runOne('run1');

    // Turn 1: the local step 'a' runs its closure once, then `ctx.step` dispatches and the run
    // suspends durably (a remote call never blocks the turn waiting for its result).
    expect(turn1?.status).toBe('suspended');
    expect(stepRuns).toBe(1);
    expect(remoteDispatches).toBe(1);

    // Simulate a fresh worker picking up the resume: a SECOND engine over the SAME store, which has
    // never executed this run before. Constructing it re-registers it as the transport's result
    // handler, so the in-flight remote result now lands on this instance.
    const engine2 = new WorkflowEngine({
      store,
      transport,
      instanceId: 'engine2',
      runDispatcher: { dispatch: () => {} },
    });
    registerCheckout(engine2);

    // Deliver the remote result (InMemoryTransport resolves it on `setImmediate`) and let the
    // resuming engine drive the run to completion.
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setImmediate(r));
      const run = await store.getRun('run1');
      if (run && run.status !== 'running' && run.status !== 'suspended') break;
    }

    const final = await store.getRun('run1');
    expect(final?.status).toBe('completed');
    expect(final?.output).toBe('ch_10');

    // Replay to the identical frontier: 'a' was already checkpointed by engine1, so engine2's turn
    // does NOT re-run its closure — only 'b' (never executed before) runs, for the first time.
    // Total closure executions across BOTH engines and ALL turns is exactly 2 — one per step.
    expect(stepRuns).toBe(2);
    // The remote step's checkpointed result is replayed, not re-dispatched, by the resuming engine.
    expect(remoteDispatches).toBe(1);

    const checkpoints = await store.listCheckpoints('run1');
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.map((cp) => cp.name)).toEqual(['a', 'billing.charge-card', 'b']);
    expect(checkpoints.every((cp) => cp.status === 'completed')).toBe(true);

    // A third, still-fresh engine over the now-completed run must not re-invoke the body at all
    // (`engine.ts` resume() short-circuits a terminal run before ever calling `fn`) — the closures
    // stay untouched. `resume` (unlike `runOne`) doesn't contend on the run lock, so this reflects
    // the same path a late-arriving result/decision takes in production.
    const engine3 = new WorkflowEngine({
      store,
      instanceId: 'engine3',
      runDispatcher: { dispatch: () => {} },
    });
    registerCheckout(engine3);
    const turn3 = await engine3.resume('run1');

    expect(turn3.status).toBe('completed');
    expect(turn3.output).toBe('ch_10');
    expect(stepRuns).toBe(2);
    expect(remoteDispatches).toBe(1);
  });
});
