import type {
  RemoteTask,
  StepEvent,
  StepInterceptor,
  StepResult,
} from '@dudousxd/nestjs-durable-core';
import {
  createStepLogger,
  runDurableExecution,
  runInStepLogger,
  runOutsideWorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { toError } from './errors';
import type { StepLog } from './workflow-context';

/**
 * A registered step handler. Receives the task's `input` and a {@link StepLog} sink (so it can record
 * sub-process outcomes + logs that ride back on {@link StepResult.events}); sync or async.
 */
export type StepHandler<I = unknown, O = unknown> = (input: I, log: StepLog) => Promise<O> | O;

/**
 * Registers step handlers by name and turns a {@link RemoteTask} into a {@link StepResult}. Pure and
 * transport-free (`processTask` is a function of the task), so it's testable without a broker — a
 * transport simply does `result = await worker.processTask(task); send(result)`. A faithful port of
 * the Python `durable_worker` step `Worker`.
 */
export class StepWorker {
  private readonly handlers = new Map<string, StepHandler>();
  private readonly interceptors: StepInterceptor[] = [];

  constructor(readonly group = 'steps') {}

  /**
   * Wrap every step handler this worker runs with `interceptor` (the engine's `engine.use`
   * contract: call `next()` to run the handler, return or transform its result, throw to fail the
   * step). First registered runs outermost. The invocation's `workflow` is `''`: a dispatched step
   * task does not carry its workflow's name. Returns an unregister function.
   */
  use(interceptor: StepInterceptor): () => void {
    this.interceptors.push(interceptor);
    return () => {
      const i = this.interceptors.indexOf(interceptor);
      if (i >= 0) this.interceptors.splice(i, 1);
    };
  }

  /** Register `handler` as the step `name`. `handler(input, log)`. */
  register<I = unknown, O = unknown>(name: string, handler: StepHandler<I, O>): this {
    this.handlers.set(name, handler as StepHandler);
    return this;
  }

  /** Whether this worker can handle the step `name`. */
  handles(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Every registered step name — the subscription surface the runner subscribes one queue per. */
  get names(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Run the handler for `task` and return a wire-format {@link StepResult}. Captures the handler's
   * emitted events + the worker's pickup time (`startedAt`, epoch ms, so the engine can report
   * queue-wait). An unknown name → a `failed` result with a clear `no handler for <name>` error
   * (mirrors Python `_no_handler`). Mirrors Python `process_task`.
   */
  async processTask(task: RemoteTask): Promise<StepResult> {
    const base = { runId: task.runId, seq: task.seq, stepId: task.stepId, startedAt: Date.now() };
    const handler = this.handlers.get(task.name);
    if (handler === undefined) {
      return {
        ...base,
        status: 'failed',
        error: { message: `no handler for ${task.name}`, retryable: false },
      };
    }

    const events: StepEvent[] = [];
    const log = createStepLogger(events, () => Date.now());
    try {
      // Bind the SAME sink ambiently too, so a helper deep inside the handler can emit via
      // `currentStep()` without the handle being threaded down (see core's `ambient-step.ts`).
      // The execution wrappers sit outside that, so a Telescope batch / OTel span opened for this
      // step is ambient while the handler runs. A thin worker has no `WorkflowEngine` at all, which
      // is why the registry they come from is process-level rather than hung off the engine.
      const output = await runDurableExecution(
        {
          unit: 'step',
          runId: task.runId,
          workflow: undefined, // not carried on the step wire format
          name: task.name,
          seq: task.seq,
          attempt: task.attempt,
        },
        // A handler is not the workflow body: never let an in-process caller's ambient ctx leak in.
        async () =>
          runOutsideWorkflowCtx(() =>
            runInStepLogger(log, () => this.intercepted(task, () => handler(task.input, log))),
          ),
      );
      const result: StepResult = { ...base, status: 'completed', output };
      if (events.length > 0) result.events = events;
      return result;
    } catch (err) {
      const result: StepResult = { ...base, status: 'failed', error: toError(err) };
      if (events.length > 0) result.events = events;
      return result;
    }
  }

  /** `body` inside the registered interceptors (just `body` when there are none). */
  private intercepted(task: RemoteTask, body: () => Promise<unknown> | unknown): Promise<unknown> {
    const run = async () => body();
    if (this.interceptors.length === 0) return run();
    const invocation = {
      runId: task.runId,
      workflow: '',
      stepName: task.name,
      seq: task.seq,
      attempt: task.attempt,
    };
    return this.interceptors.reduceRight<() => Promise<unknown>>(
      (next, interceptor) => () => interceptor(invocation, next),
      run,
    )();
  }
}
