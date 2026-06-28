import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

/**
 * A workflow-task-capable {@link Transport} standing in for a worker on a group: it records each
 * dispatched {@link WorkflowTask} and replies on the decisions channel (async, mirroring a real
 * broker) with whatever `decide` computes from the task. This is what `engine.remote()` must wire a
 * {@link RemoteWorkflowExecutor} over — unlike the bare InMemoryTransport, it supports
 * `dispatchWorkflowTask` + `onDecision`.
 */
class WorkerTransport implements Transport {
  readonly dispatched: WorkflowTask[] = [];
  private decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  constructor(private readonly decide: (task: WorkflowTask) => WorkflowDecision) {}

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatched.push(task);
    const decision = this.decide(task);
    setImmediate(() => void this.decisionHandler?.(decision));
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

describe('engine.remote() — convenience form of registerRemote', () => {
  it('registers a remote workflow on the group and advances it over the engine transport', async () => {
    const store = new InMemoryStateStore();
    // A single-turn worker body: complete immediately, echoing the input.
    const transport = new WorkerTransport((task) => ({
      taskId: task.taskId,
      runId: task.runId,
      status: 'completed',
      commands: [],
      output: { greeting: `hi ${task.input}` },
    }));

    const engine = new WorkflowEngine({ store, transport });
    // No hand-built RemoteWorkflowExecutor — the sugar wires it over the engine's own transport.
    engine.remote('processing', { group: 'processing' });

    await startRun(engine, 'processing', 'davi', 'run1');
    const run = await settle(store, 'run1');

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ greeting: 'hi davi' });
    // It dispatched a WORKFLOW task (not a step) to the named group, over the engine's transport.
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]?.group).toBe('processing');
    expect(transport.dispatched[0]?.workflow).toBe('processing');
    // Defaulted the version to '1' (the run started on it).
    expect(run.workflowVersion).toBe('1');
  });

  it('passes registerRemote options through (e.g. validateInput rejects before a run is created)', async () => {
    const store = new InMemoryStateStore();
    const transport = new WorkerTransport((task) => ({
      taskId: task.taskId,
      runId: task.runId,
      status: 'completed',
      commands: [],
      output: null,
    }));

    const engine = new WorkflowEngine({ store, transport });
    engine.remote('guarded', {
      group: 'processing',
      version: '2',
      validateInput: (input) => {
        if (input == null) throw new Error('input required');
      },
    });

    await expect(startRun(engine, 'guarded', null, 'bad1')).rejects.toThrow('input required');
    expect(await store.getRun('bad1')).toBeNull();

    // A valid input starts and the version we passed is honoured.
    await startRun(engine, 'guarded', { ok: true }, 'good1');
    const run = await settle(store, 'good1');
    expect(run.status).toBe('completed');
    expect(run.workflowVersion).toBe('2');
  });
});
