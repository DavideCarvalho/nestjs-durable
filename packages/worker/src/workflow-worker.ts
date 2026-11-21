import {
  type WorkflowDecision,
  type WorkflowStepEvent,
  type WorkflowTask,
  runDurableExecution,
  runInWorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { Cancelled, ContinuedAsNew, StepFailed, Suspend, toError } from './errors';
import { WorkflowContext } from './workflow-context';

/**
 * Restores an opaque context carrier around `fn` (for `@dudousxd/nestjs-context`, its
 * `Context.deserialize`) — the bridge the engine's own `rehydrate` option takes. The worker calls it
 * with the carrier a dispatched task carries (`undefined` when it carries none) around the whole
 * turn or step handler, outside the durable execution wrappers.
 */
export type ContextRehydrate = <T>(carrier: Record<string, unknown> | undefined, fn: () => T) => T;

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

  /**
   * `options.compensationRetries` is how many times each `localStep` `compensate` is tried when a
   * failed turn unwinds its saga, as the engine's own `compensationRetries` (default 1).
   * `options.rehydrate` restores each turn's {@link WorkflowTask.context} around the replay.
   */
  constructor(
    readonly group = 'workflows',
    private readonly options: { compensationRetries?: number; rehydrate?: ContextRehydrate } = {},
  ) {}

  /** Register `fn` as the workflow `name`. `fn(ctx, input)` (or `fn(ctx)`). */
  register(name: string, fn: WorkflowFn): this {
    this.workflows.set(name, fn);
    return this;
  }

  /** Whether this worker can handle the workflow `name`. */
  handles(name: string): boolean {
    return this.workflows.has(name);
  }

  /** Every registered workflow name — the subscription surface the runner subscribes one queue per. */
  get names(): string[] {
    return [...this.workflows.keys()];
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

    // One turn = one unit of durable work, so the registered execution wrappers bracket the whole
    // replay (body + the classification of what it threw), not just the body call: a Suspend or a
    // StepFailed is part of this turn's story and belongs inside the same observability scope.
    // The carrier is restored outside the wrappers, as the engine restores it around a local step,
    // so a wrapper's own scope (a tenant, a span) is opened inside the originating context.
    const turn = () =>
      runDurableExecution(
        {
          unit: 'workflow',
          runId: task.runId,
          workflow: task.workflow,
          name: undefined,
          seq: undefined,
          attempt: undefined,
          context: task.context,
        },
        () => this.replayTurn(base, fn, task, opts),
      );
    const rehydrate = this.options.rehydrate;
    if (!rehydrate) return turn();
    let started = false;
    try {
      return await rehydrate(task.context, () => {
        started = true;
        return turn();
      });
    } catch (err) {
      if (started) throw err;
      // The carrier could not be restored (an app deserializer rejected it, e.g. one changed by a
      // rolling deploy). It is correlation only, so the turn runs without it rather than failing the
      // run; the engine still applies the run's tenant to the decision.
      console.warn(
        `[nestjs-durable] run ${task.runId}: could not restore the turn's context carrier, running it without: ${err instanceof Error ? err.message : String(err)}`,
      );
      return turn();
    }
  }

  /** The replay itself — see {@link processTask}, which wraps this in the execution hooks. */
  private async replayTurn(
    base: { taskId: string; runId: string },
    fn: WorkflowFn,
    task: WorkflowTask,
    opts: ProcessTaskOptions,
  ): Promise<WorkflowDecision> {
    const ctx = new WorkflowContext(task.runId, task.history, {
      // A no-explicit-partition `ctx.step` call inherits THIS worker's group as its
      // partition — continuity with the pre-redesign "one group, one worker" default.
      workflowPartition: this.group,
      pendingSignals: task.pendingSignals,
      // Each event names this turn, so the engine can drop the events of a turn it no longer awaits.
      onStep:
        opts.onStep === undefined
          ? undefined
          : (event) => opts.onStep?.({ ...event, taskId: base.taskId }),
      isCancelled: opts.isCancelled,
      features: task.features,
      compensationRetries: this.options.compensationRetries,
    });

    try {
      // Same ambient-context wrap as the engine's body execution: class-first statics
      // (`MyWorkflow.execute()`) inside a thin-worker body resolve THIS ctx.
      const output = await runInWorkflowCtx(ctx, () => fn(ctx, task.input));
      return { ...base, status: 'completed', commands: ctx.commands, output };
    } catch (err) {
      if (err instanceof Suspend) {
        return { ...base, status: 'continue', commands: ctx.commands };
      }
      if (err instanceof ContinuedAsNew) {
        // Terminal: the last command is `continueAsNew`, which the engine applies as the handoff.
        return { ...base, status: 'completed', commands: ctx.commands };
      }
      if (err instanceof Cancelled) {
        // Cancelled at an op boundary. Return the steps that DID run this turn so the engine can
        // record partial progress; the engine already set status=cancelled.
        return { ...base, status: 'cancelled', commands: ctx.commands };
      }
      const error = err instanceof StepFailed ? err.error : toError(err);
      // Saga: undo the completed local steps in reverse before reporting the failure, as the engine
      // does in-process. The undo outcomes ride this decision as `compensate:<step>` records; the
      // run's error stays the original failure.
      await ctx.runCompensations();
      return { ...base, status: 'failed', commands: ctx.commands, error };
    }
  }
}
