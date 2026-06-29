import type {
  HistoryEvent,
  Transport,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowTask,
} from './interfaces';

let taskCounter = 0;

/**
 * A {@link WorkflowExecutor} backed by a {@link Transport}: it advances a remote workflow by
 * DISPATCHING a {@link WorkflowTask} over the broker and returning the dispatched `taskId` WITHOUT
 * awaiting the decision. Pass one to `engine.registerRemote(name, version, { group, executor })` so a
 * workflow authored in another SDK (e.g. the Python `durable-worker`) is driven over Redis/BullMQ.
 *
 * Multi-instance safe by construction: the executor holds NO in-memory state correlating a dispatched
 * turn to its decision. The engine suspends the run recording the dispatched `taskId`, and the
 * worker's {@link import('./interfaces').WorkflowDecision} is delivered over the transport's
 * `onDecision` and applied DURABLY (by run id) on whatever engine instance consumes it — even if that
 * is not the instance that dispatched the turn. A point-to-point broker can therefore hand the
 * decision to any instance without it being dropped (the bug this design fixes).
 *
 * Recovery-safe: if the engine crashes (or a decision is genuinely lost because the worker died), the
 * suspended turn's heartbeat-rearmed window (`remoteAdvanceSilenceMs`) lapses and the timer poller
 * re-dispatches a fresh task with the same history — the worker's replay is deterministic, so it
 * returns the same decision; a late decision for the old `taskId` no longer matches the run's
 * currently-awaited turn and is dropped.
 */
export class RemoteWorkflowExecutor implements WorkflowExecutor {
  constructor(
    private readonly transport: Transport,
    private readonly group: string,
    // Accepted for source compatibility; liveness now lives on the engine's suspended-turn window
    // (`remoteAdvanceSilenceMs`) + recovery re-drive, not an in-memory per-turn timeout.
    _opts: { timeoutMs?: number } = {},
  ) {}

  /**
   * Dispatch one workflow turn and return its `taskId`. Does NOT await the decision — the engine
   * suspends the run on the returned `taskId` and applies the decision durably via `onDecision`.
   */
  async dispatch(
    run: WorkflowRun,
    history: HistoryEvent[],
    pendingSignals?: WorkflowTask['pendingSignals'],
  ): Promise<{ taskId: string }> {
    if (!this.transport.dispatchWorkflowTask) {
      throw new Error('transport does not support workflow tasks (dispatchWorkflowTask)');
    }
    taskCounter += 1;
    const taskId = `${run.id}:wf:${taskCounter}`;
    const task: WorkflowTask = {
      taskId,
      runId: run.id,
      workflow: run.workflow,
      workflowVersion: run.workflowVersion,
      input: run.input,
      history,
      ...(pendingSignals ? { pendingSignals } : {}),
      group: this.group,
      priority: run.priority,
      attempt: 1,
    };
    await this.transport.dispatchWorkflowTask(task);
    return { taskId };
  }
}
