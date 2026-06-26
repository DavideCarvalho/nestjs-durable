import { WorkflowEngine } from './engine';
import type { HistoryEvent, WorkflowDecision, WorkflowExecutor, WorkflowRun } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/**
 * A single GROUP executor — the shape a real {@link WorkflowExecutor} has: it dispatches a task to one
 * worker group and the worker picks the body by `run.workflow`, so ONE executor instance serves MANY
 * workflow names. Here it hosts a `parent` that fans out to an UNREGISTERED `leaf`, plus the `leaf`
 * body itself. `advanced` records every `(workflow, runId)` it drove, so a test can prove the child
 * was routed through THIS same instance (inheritance) rather than a separately-registered one.
 */
function groupExecutor(advanced: Set<string>): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      advanced.add(`${run.workflow}:${run.id}`);
      const bySeq = new Map(history.map((e) => [e.seq, e]));
      const base = { taskId: 't', runId: run.id } as const;

      if (run.workflow === 'leaf') {
        return {
          ...base,
          status: 'completed',
          commands: [],
          output: { doubled: (run.input as number) * 2 },
        };
      }

      // `parent`: start ONE child of the unregistered `leaf` and await it, then echo its output.
      if (run.workflow === 'parent') {
        if (!bySeq.has(0)) {
          return {
            ...base,
            status: 'continue',
            commands: [{ kind: 'startChild', seq: 0, workflow: 'leaf', input: 21 }],
          };
        }
        return {
          ...base,
          status: 'completed',
          commands: [],
          output: { fromChild: bySeq.get(0)?.output },
        };
      }

      // `fanout`: gather TWO children of the unregistered `leaf` (a gather_children-style fan-out).
      if (run.workflow === 'fanout') {
        if (!bySeq.has(0) && !bySeq.has(1)) {
          return {
            ...base,
            status: 'continue',
            commands: [
              { kind: 'startChild', seq: 0, workflow: 'leaf', input: 21 },
              { kind: 'startChild', seq: 1, workflow: 'leaf', input: 10 },
            ],
          };
        }
        if (!bySeq.has(0) || !bySeq.has(1)) {
          // One child landed; keep waiting on the other (no new commands → re-suspend on its waiter).
          return { ...base, status: 'continue', commands: [] };
        }
        const a = bySeq.get(0)?.output as { doubled: number };
        const b = bySeq.get(1)?.output as { doubled: number };
        return {
          ...base,
          status: 'completed',
          commands: [],
          output: { sum: a.doubled + b.doubled },
        };
      }

      throw new Error(`unexpected workflow ${run.workflow}`);
    },
  };
}

describe("WorkflowEngine — a remote parent's child inherits its remote group/executor", () => {
  it("drives an UNREGISTERED child of a remote workflow as remote on the parent's group + executor", async () => {
    const store = new InMemoryStateStore();
    const advanced = new Set<string>();
    const executor = groupExecutor(advanced);
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    // ONLY the parent is registered remote. `leaf` is never registered.
    engine.registerRemote('parent', '7', { group: 'py-workflows', executor });

    await startRun(engine, 'parent', {}, 'par1');
    const run = await settle(store, 'par1');

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ fromChild: { doubled: 42 } });

    // The child ran as its own run, under the deterministic `${parent}.child.${seq}` id…
    const child = await store.getRun('par1.child.0');
    expect(child?.status).toBe('completed');
    // …it inherited the parent's remote VERSION (proof the synthesized registration was used)…
    expect(child?.workflowVersion).toBe('7');
    // …and it was advanced by the SAME group executor instance (not a separate registration).
    expect(advanced.has('leaf:par1.child.0')).toBe(true);
  });

  it('an explicit registerRemote for the child takes precedence over inheritance', async () => {
    const store = new InMemoryStateStore();
    const advanced = new Set<string>();
    const parentExec = groupExecutor(advanced);
    // A DISTINCT executor on a DISTINCT group for the explicitly-registered leaf.
    const ownExecutor: WorkflowExecutor = {
      async advance(run) {
        return {
          taskId: 't',
          runId: run.id,
          status: 'completed',
          commands: [],
          output: { own: true },
        };
      },
    };
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    engine.registerRemote('parent', '7', { group: 'py-workflows', executor: parentExec });
    engine.registerRemote('leaf', '3', { group: 'leaf-group', executor: ownExecutor });

    await startRun(engine, 'parent', {}, 'par2');
    const run = await settle(store, 'par2');

    expect(run.status).toBe('completed');
    // The explicit leaf executor ran (its own output), NOT the inherited parent group's doubling body.
    expect(run.output).toEqual({ fromChild: { own: true } });
    const child = await store.getRun('par2.child.0');
    expect(child?.workflowVersion).toBe('3'); // the leaf's OWN registered version, not the parent's '7'
    expect(advanced.has('leaf:par2.child.0')).toBe(false); // parent group's executor never saw the leaf
  });

  it('inherits across a multi-child fan-out (gather_children of an unregistered workflow)', async () => {
    const store = new InMemoryStateStore();
    const advanced = new Set<string>();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    engine.registerRemote('fanout', '1', {
      group: 'py-workflows',
      executor: groupExecutor(advanced),
    });

    await startRun(engine, 'fanout', {}, 'fan1');
    const run = await settle(store, 'fan1');

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ sum: 62 }); // 21*2 + 10*2
    expect(advanced.has('leaf:fan1.child.0')).toBe(true);
    expect(advanced.has('leaf:fan1.child.1')).toBe(true);
    expect((await store.getRun('fan1.child.0'))?.status).toBe('completed');
    expect((await store.getRun('fan1.child.1'))?.status).toBe('completed');
  });

  it('still throws the skew-protection error for an unregistered run with NO remote ancestor', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    // A run with no registration and no parent waiter — the genuine misconfiguration case.
    await store.createRun({
      id: 'orphan1',
      workflow: 'ghost',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(engine.resume('orphan1')).rejects.toThrow('is not registered');
  });
});
