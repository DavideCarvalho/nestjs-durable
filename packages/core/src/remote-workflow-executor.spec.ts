import type { Transport, WorkflowRun, WorkflowTask } from './interfaces';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';

function run(): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'greet',
    workflowVersion: '1',
    input: 'davi',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RemoteWorkflowExecutor', () => {
  it('dispatches a workflow task and returns its taskId WITHOUT awaiting a decision', async () => {
    let dispatched: WorkflowTask | undefined;
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
      dispatchWorkflowTask: async (t) => {
        dispatched = t;
      },
    };
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');
    // The executor is dispatch-only (no in-memory pending map): it resolves as soon as the task is
    // dispatched. The decision is applied durably by the engine via the transport's onDecision, keyed
    // by the run id — not correlated to an in-memory promise here. So a multi-instance broker can hand
    // the decision to ANY instance without it being dropped.
    const { taskId } = await exec.dispatch(run(), []);
    expect(dispatched?.group).toBe('py-wf');
    expect(dispatched?.workflow).toBe('greet');
    expect(dispatched?.taskId).toBe(taskId);
    expect(taskId.startsWith('r1:wf:')).toBe(true);
  });

  it('threads pendingSignals onto the dispatched task and omits them when none', async () => {
    let dispatched: WorkflowTask | undefined;
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
      dispatchWorkflowTask: async (t) => {
        dispatched = t;
      },
    };
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');
    await exec.dispatch(run(), [], [{ seq: 1, signal: 'go', payload: { ok: true } }]);
    expect(dispatched?.pendingSignals).toEqual([{ seq: 1, signal: 'go', payload: { ok: true } }]);
    await exec.dispatch(run(), []);
    expect(dispatched?.pendingSignals).toBeUndefined();
  });

  it('throws when the transport cannot carry workflow tasks', async () => {
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
    };
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');
    await expect(exec.dispatch(run(), [])).rejects.toThrow(/dispatchWorkflowTask/);
  });
});
