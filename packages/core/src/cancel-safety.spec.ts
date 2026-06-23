import type { HistoryEvent, WorkflowDecision, WorkflowRun } from './interfaces';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('WorkflowEngine — cancelled runs are not resurrected', () => {
  it('resume() is a no-op on a cancelled run (a late event cannot re-run it)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    let ran = 0;
    engine.register('wf', '1', async (ctx) => {
      await ctx.step('after-signal', async () => {
        ran += 1;
      });
      return 'ok';
    });

    // Suspend on a signal, cancel, then a late resume must not execute the body.
    engine.register('wf', '1', async (ctx) => {
      ran += 1;
      await ctx.waitForSignal('go');
    });
    await engine.start('wf', {}, 'run1');
    await engine.cancel('run1');
    const before = ran;

    const result = await engine.resume('run1');
    expect(result.status).toBe('cancelled');
    expect(ran).toBe(before); // body did NOT re-run
  });

  it('remote workflow: a continue/suspended decision does not overwrite cancelled (resurrection guard)', async () => {
    // Regression test for the bug where runRemoteExecution called settleRun({ kind: 'suspended' })
    // after the store had already been written to `cancelled` by a parent cancel cascade, causing
    // recovery to re-drive the run forever.
    //
    // Approach: use a no-op runDispatcher so the run stays `pending` (no implicit microtask dispatch),
    // then manually drive the execution. The executor writes `cancelled` to the store mid-advance to
    // simulate the parent cascade race; the engine must NOT overwrite it with `suspended`.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      // No-op dispatcher: prevents the implicit microtask dispatch from racing our explicit runOne.
      runDispatcher: { dispatch: () => Promise.resolve() },
    });
    engine.registerRemote('child-wf', '1', {
      group: 'py',
      executor: {
        async advance(run: WorkflowRun, _history: HistoryEvent[]): Promise<WorkflowDecision> {
          // Simulate parent cancel cascade writing `cancelled` to the store while advance() awaits.
          await store.updateRun(run.id, { status: 'cancelled', error: { message: 'cancelled' }, updatedAt: new Date() });
          // Worker still returns `continue` — the bug was that this overwrote `cancelled` → `suspended`.
          return { taskId: 't', runId: run.id, status: 'continue', commands: [] };
        },
      },
    });

    await engine.start('child-wf', {}, 'child1');
    expect((await store.getRun('child1'))?.status).toBe('pending');

    // runOne picks it up; after runRemoteExecution the status must still be `cancelled`.
    await engine.runOne('child1');

    const run = await store.getRun('child1');
    expect(run?.status).toBe('cancelled'); // must NOT be `suspended`

    // A second runOne must be a no-op (the run is terminal, not re-driven).
    await engine.runOne('child1');
    const runAfter = await store.getRun('child1');
    expect(runAfter?.status).toBe('cancelled');
  });
});
