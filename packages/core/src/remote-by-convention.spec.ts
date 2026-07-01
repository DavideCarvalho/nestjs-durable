import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/**
 * A workflow-task-capable Transport that also reports live worker groups.
 * Records every dispatched {@link WorkflowTask} group and immediately completes the run
 * by delivering a decision over `onDecision` — mirroring a real worker that processes
 * the task synchronously.
 */
class ConventionTransport implements Transport {
  readonly dispatchedGroups: string[] = [];
  private decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return ['processing'];
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatchedGroups.push(task.group);
    const decision: WorkflowDecision = {
      taskId: task.taskId,
      runId: task.runId,
      status: 'completed',
      commands: [],
      output: { fromConvention: true },
    };
    setImmediate(() => void this.decisionHandler?.(decision));
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

/**
 * A transport that has no live worker groups — listWorkerGroups returns an empty array.
 * Used to verify that convention routing does NOT kick in when the group is not live.
 */
class EmptyGroupsTransport implements Transport {
  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return [];
  }

  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}

  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}
}

describe('WorkflowEngine — remoteByConvention routing', () => {
  it('routes an unregistered workflow to the live group of the same name', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();
    const engine = new WorkflowEngine({
      store,
      transport,
      namespace: 'default',
      remoteByConvention: true,
    });

    // 'processing' is never registered locally — convention routing must discover and route it.
    await engine.start('processing', { hello: 'world' }, 'conv1');
    const run = await settle(store, 'conv1');

    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ fromConvention: true });
    // A workflow task must have been dispatched to the group of the SAME name.
    expect(transport.dispatchedGroups).toEqual(['processing']);
  });

  it('default (remoteByConvention: false) throws "not registered" for an unregistered workflow', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();
    // No remoteByConvention flag → defaults to false.
    const engine = new WorkflowEngine({ store, transport });

    await expect(engine.start('processing', { hello: 'world' }, 'conv2')).rejects.toThrow(
      'not registered',
    );
  });

  it('throws "not registered" when remoteByConvention is true but the group is not live', async () => {
    const store = new InMemoryStateStore();
    const transport = new EmptyGroupsTransport();
    const engine = new WorkflowEngine({
      store,
      transport,
      remoteByConvention: true,
    });

    await expect(engine.start('processing', { hello: 'world' }, 'conv3')).rejects.toThrow(
      'not registered',
    );
  });

  it('an explicit engine.remote() registration takes precedence over convention routing', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();
    const engine = new WorkflowEngine({
      store,
      transport,
      remoteByConvention: true,
    });

    // Explicit registration routes to a DIFFERENT group ('explicit-group'), not the workflow name.
    engine.remote('processing', { group: 'explicit-group' });

    await engine.start('processing', { hello: 'world' }, 'conv4');
    const run = await settle(store, 'conv4');

    expect(run?.status).toBe('completed');
    // The explicit registration's group ('explicit-group') wins over convention ('processing').
    expect(transport.dispatchedGroups).toEqual(['explicit-group']);
  });
});
