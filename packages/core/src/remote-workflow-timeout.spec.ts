import { WorkflowEngine } from './engine';
import { RemoteWorkflowTimeout } from './errors';
import type { WorkflowDecision, WorkflowExecutor, WorkflowRun } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/** Poll the run until it reaches a TERMINAL state (completed/failed/cancelled/dead). Returns the run,
 *  or null if it never settles within the bounded number of ticks (used to assert a STUCK run). */
async function pollTerminal(store: InMemoryStateStore, runId: string, ticks = 50) {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  return null;
}

describe('WorkflowEngine — remote advance timeout → recovery re-drive (opt-in)', () => {
  it('BUG: a dropped decision with NO timeout leaves the run stuck running (never settles)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    // An executor whose `advance` never resolves — models a decision that was dropped (stall/redelivery
    // or instance restart spanning the in-memory waiter map). With NO timeout configured (current
    // default), the engine awaits it forever.
    engine.registerRemote('stuck', '1', {
      group: 'py-workflows',
      executor: {
        advance() {
          return new Promise<WorkflowDecision>(() => {
            /* never resolves */
          });
        },
      },
    });

    await engine.start('stuck', {}, 'stuck1');
    // give the dispatcher a chance to pick it up and call advance
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));

    const settled = await pollTerminal(store, 'stuck1');
    expect(settled).toBeNull(); // documents the bug: never settles
    const run = await store.getRun('stuck1');
    expect(run?.status).toBe('running'); // stuck running, lease held, parent never notified
  });

  it('with a configured timeout, a dropped decision re-drives via recovery and settles completed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });

    // Fake the configured-timeout executor deterministically: the FIRST advance (the in-line drive)
    // throws RemoteWorkflowTimeout (decision dropped); the SECOND advance (the recovery re-drive,
    // replaying deterministically) returns the real `completed` decision.
    let calls = 0;
    const executor: WorkflowExecutor = {
      async advance(run: WorkflowRun): Promise<WorkflowDecision> {
        calls += 1;
        if (calls === 1) throw new RemoteWorkflowTimeout(`${run.id}:wf:1`, 25);
        return {
          taskId: 't',
          runId: run.id,
          status: 'completed',
          commands: [],
          output: { ok: true },
        };
      },
    };
    engine.registerRemote('flaky', '1', { group: 'py-workflows', executor });

    // NOT startRun (which would block on waitForRun): after the timeout the run stays `running`, so it
    // never "settles" until recovery re-drives it. Enqueue and poll for the post-timeout state instead.
    await engine.start('flaky', {}, 'flaky1');
    let afterTimeout = await store.getRun('flaky1');
    for (let i = 0; i < 50 && (afterTimeout?.status ?? 'pending') === 'pending'; i += 1) {
      await new Promise((r) => setImmediate(r));
      afterTimeout = await store.getRun('flaky1');
    }
    // After the timed-out first advance, the run must NOT be failed: it stays running with a RELEASED
    // lease so recovery can re-acquire it.
    expect(afterTimeout?.status).toBe('running');
    expect(afterTimeout?.status).not.toBe('failed');
    expect(afterTimeout?.lockedUntil).toBeUndefined(); // lease released

    // Recovery re-drives the (now free) lease; the second advance returns completed → settles.
    await engine.recoverIncomplete();
    const done = await pollTerminal(store, 'flaky1');
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('notifies a waiting parent after a timeout→re-drive settles the child', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });

    let childCalls = 0;
    engine.registerRemote('child', '1', {
      group: 'py-workflows',
      executor: {
        async advance(run: WorkflowRun): Promise<WorkflowDecision> {
          childCalls += 1;
          if (childCalls === 1) throw new RemoteWorkflowTimeout(`${run.id}:wf:1`, 25);
          return {
            taskId: 't',
            runId: run.id,
            status: 'completed',
            commands: [],
            output: { doubled: (run.input as number) * 2 },
          };
        },
      },
    });
    engine.registerRemote('parent', '1', {
      group: 'py-workflows',
      executor: {
        async advance(run: WorkflowRun, history): Promise<WorkflowDecision> {
          const bySeq = new Map(history.map((e) => [e.seq, e]));
          const base = { taskId: 't', runId: run.id } as const;
          if (!bySeq.has(0)) {
            return {
              ...base,
              status: 'continue',
              commands: [{ kind: 'startChild', seq: 0, workflow: 'child', input: 21 }],
            };
          }
          return {
            ...base,
            status: 'completed',
            commands: [],
            output: { fromChild: bySeq.get(0)?.output },
          };
        },
      },
    });

    await startRun(engine, 'parent', {}, 'p1');
    // the child's first advance timed out; it is stuck running (lease released), parent still suspended.
    let childAfter = await store.getRun('p1.child.0');
    for (let i = 0; i < 50 && childAfter?.status !== 'running'; i += 1) {
      await new Promise((r) => setImmediate(r));
      childAfter = await store.getRun('p1.child.0');
    }
    expect(childAfter?.status).toBe('running');
    expect(childAfter?.lockedUntil).toBeUndefined(); // lease released, recoverable
    expect((await store.getRun('p1'))?.status).toBe('suspended');

    // recovery re-drives the child → completes → notifies parent → parent completes.
    await engine.recoverIncomplete();
    const child = await pollTerminal(store, 'p1.child.0');
    expect(child?.status).toBe('completed');
    const parent = await pollTerminal(store, 'p1');
    expect(parent?.status).toBe('completed');
    expect(parent?.output).toEqual({ fromChild: { doubled: 42 } });
  });

  it('a NON-timeout advance error still fails the run (unchanged behavior)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    engine.registerRemote('boom', '1', {
      group: 'py-workflows',
      executor: {
        async advance(): Promise<WorkflowDecision> {
          throw new Error('executor exploded');
        },
      },
    });

    await startRun(engine, 'boom', {}, 'boom1');
    const run = await pollTerminal(store, 'boom1');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toBe('executor exploded');
  });
});
