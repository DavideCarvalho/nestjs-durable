import { WorkflowEngine } from './engine';
import type {
  HistoryEvent,
  Transport,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowTask,
} from './interfaces';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

function runWith(priority?: number): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'processing',
    workflowVersion: '1',
    input: {},
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(priority != null ? { priority } : {}),
  };
}

describe('RemoteWorkflowExecutor carries the run priority onto the dispatched WorkflowTask', () => {
  it('stamps run.priority onto the WorkflowTask', async () => {
    let dispatched: WorkflowTask | undefined;
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
      dispatchWorkflowTask: async (t) => {
        dispatched = t;
      },
    };
    const exec = new RemoteWorkflowExecutor(transport, 'processing-workflows');
    await exec.dispatch(runWith(5), []);
    expect(dispatched?.priority).toBe(5);
  });

  it('omits priority on the WorkflowTask when the run has none', async () => {
    let dispatched: WorkflowTask | undefined;
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
      dispatchWorkflowTask: async (t) => {
        dispatched = t;
      },
    };
    const exec = new RemoteWorkflowExecutor(transport, 'processing-workflows');
    await exec.dispatch(runWith(), []);
    expect(dispatched?.priority).toBeUndefined();
  });
});

/** Captures the child run the engine hands to the remote executor, so we can assert its priority. */
function recordingExecutor(seen: WorkflowRun[]): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun, _history: HistoryEvent[]): Promise<WorkflowDecision> {
      seen.push(run);
      return {
        taskId: 'task',
        runId: run.id,
        status: 'completed',
        commands: [],
        output: { ok: true },
      };
    },
  };
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending')
      return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('ctx.child priority reaches the child run', () => {
  it('starts the remote child workflow with the priority passed to ctx.child', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const seen: WorkflowRun[] = [];

    const engine = new WorkflowEngine({ store, transport });
    engine.registerRemote('processing', '1', {
      group: 'processing-workflows',
      executor: recordingExecutor(seen),
    });
    engine.register('pipeline', '1', async (ctx) => {
      await ctx.child('processing', { base: 'b1' }, { priority: 8 });
      return 'done';
    });

    await startRun(engine, 'pipeline', {}, 'parent1');
    await settle(store, 'parent1');

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.priority).toBe(8);
  });
});
