import type { RemoteTask, StepEvent, StepResult } from '@dudousxd/nestjs-durable-core';
import { toError } from './errors';
import { type StepLog, makeStepLog } from './workflow-context';

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

  constructor(readonly group = 'steps') {}

  /** Register `handler` as the step `name`. `handler(input, log)`. */
  register<I = unknown, O = unknown>(name: string, handler: StepHandler<I, O>): this {
    this.handlers.set(name, handler as StepHandler);
    return this;
  }

  /** Whether this worker can handle the step `name`. */
  handles(name: string): boolean {
    return this.handlers.has(name);
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
    const log = makeStepLog(events);
    try {
      const output = await handler(task.input, log);
      const result: StepResult = { ...base, status: 'completed', output };
      if (events.length > 0) result.events = events;
      return result;
    } catch (err) {
      const result: StepResult = { ...base, status: 'failed', error: toError(err) };
      if (events.length > 0) result.events = events;
      return result;
    }
  }
}
