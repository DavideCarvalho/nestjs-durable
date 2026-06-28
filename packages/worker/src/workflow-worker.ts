import type {
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { Cancelled, StepFailed, Suspend, toError } from './errors';
import { WorkflowContext } from './workflow-context';

/** A registered workflow body. Receives the {@link WorkflowContext} and the run's input. */
export type WorkflowFn = (ctx: WorkflowContext, input: unknown) => Promise<unknown> | unknown;

/** Per-task hooks the runner feeds into the replay (live step streaming + cooperative cancellation). */
export interface ProcessTaskOptions {
  onStep?: (event: WorkflowStepEvent) => void;
  isCancelled?: (runId: string) => boolean;
}

/**
 * Registers workflow functions by name and turns a {@link WorkflowTask} into a {@link WorkflowDecision}.
 * Pure and transport-free (`processTask` is a function of the task), so it's testable without a
 * broker. A faithful port of the Python `durable_worker` `WorkflowWorker`.
 */
export class WorkflowWorker {
  private readonly workflows = new Map<string, WorkflowFn>();

  constructor(readonly group = 'workflows') {}

  /** Register `fn` as the workflow `name`. `fn(ctx, input)` (or `fn(ctx)`). */
  register(name: string, fn: WorkflowFn): this {
    this.workflows.set(name, fn);
    return this;
  }

  /** Whether this worker can handle the workflow `name`. */
  handles(name: string): boolean {
    return this.workflows.has(name);
  }

  /**
   * Replay one turn of `task`'s workflow and return the wire-format decision. `onStep`, when given,
   * streams each local step's lifecycle (running → completed/failed) to the engine live;
   * `isCancelled` lets the replay bail at an op boundary when the run was cancelled (returns a
   * `cancelled` decision). Mirrors Python `process_task`.
   */
  async processTask(task: WorkflowTask, opts: ProcessTaskOptions = {}): Promise<WorkflowDecision> {
    const base = { taskId: task.taskId, runId: task.runId };
    const fn = this.workflows.get(task.workflow);
    if (fn === undefined) {
      return {
        ...base,
        status: 'failed',
        commands: [],
        error: {
          message: `no workflow registered for ${JSON.stringify(task.workflow)}`,
          code: 'no_workflow',
        },
      };
    }

    const ctx = new WorkflowContext(task.runId, task.history, {
      // A no-explicit-group `ctx.call` step inherits THIS worker's group, so the step lands on the
      // same `<prefix>-tasks-<group>` queue as the workflow (the "one group, one worker" model).
      workflowGroup: this.group,
      pendingSignals: task.pendingSignals,
      onStep: opts.onStep,
      isCancelled: opts.isCancelled,
    });

    try {
      const output = await fn(ctx, task.input);
      return { ...base, status: 'completed', commands: ctx.commands, output };
    } catch (err) {
      if (err instanceof Suspend) {
        return { ...base, status: 'continue', commands: ctx.commands };
      }
      if (err instanceof Cancelled) {
        // Cancelled at an op boundary. Return the steps that DID run this turn so the engine can
        // record partial progress; the engine already set status=cancelled.
        return { ...base, status: 'cancelled', commands: ctx.commands };
      }
      if (err instanceof StepFailed) {
        return { ...base, status: 'failed', commands: ctx.commands, error: err.error };
      }
      return { ...base, status: 'failed', commands: ctx.commands, error: toError(err) };
    }
  }
}
