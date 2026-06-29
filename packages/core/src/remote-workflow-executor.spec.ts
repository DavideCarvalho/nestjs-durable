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
  it('enqueues a workflow task under the engine-supplied taskId WITHOUT awaiting a decision', async () => {
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
    // The executor is enqueue-only (no in-memory pending map): it resolves as soon as the task is on the
    // broker. The engine generated and recorded the `taskId` BEFORE calling this; the decision is applied
    // durably by the engine via the transport's onDecision, keyed by the run id — not correlated to an
    // in-memory promise here. So a multi-instance broker can hand the decision to ANY instance unharmed.
    await exec.dispatch(run(), [], 'r1:wf:abcd1234');
    expect(dispatched?.group).toBe('py-wf');
    expect(dispatched?.workflow).toBe('greet');
    expect(dispatched?.taskId).toBe('r1:wf:abcd1234');
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
    await exec.dispatch(run(), [], 'r1:wf:aaaa', [{ seq: 1, signal: 'go', payload: { ok: true } }]);
    expect(dispatched?.pendingSignals).toEqual([{ seq: 1, signal: 'go', payload: { ok: true } }]);
    await exec.dispatch(run(), [], 'r1:wf:bbbb');
    expect(dispatched?.pendingSignals).toBeUndefined();
  });

  it('throws when the transport cannot carry workflow tasks', async () => {
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
    };
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');
    await expect(exec.dispatch(run(), [], 'r1:wf:cccc')).rejects.toThrow(/dispatchWorkflowTask/);
  });
});
