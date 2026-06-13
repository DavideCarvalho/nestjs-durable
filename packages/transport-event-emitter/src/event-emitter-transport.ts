import {
  type ControlMessage,
  type Heartbeat,
  type RemoteTask,
  type StepHandler,
  type StepResult,
  type Transport,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import type { EventEmitter2 } from 'eventemitter2';

export const TASK_EVENT = 'durable.task';
export const RESULT_EVENT = 'durable.result';
export const HEARTBEAT_EVENT = 'durable.heartbeat';
export const CONTROL_EVENT = 'durable.control';

/**
 * An in-process `Transport` backed by `@nestjs/event-emitter`'s `EventEmitter2`.
 *
 * Zero extra infrastructure: step handlers run in the same process, fully decoupled from the
 * workflow that calls them. Swap to a queue-backed transport (BullMQ/NATS) for true
 * cross-process or cross-language steps.
 */
export class EventEmitterTransport implements Transport {
  private readonly handlers = new Map<string, StepHandler>();

  constructor(private readonly emitter: EventEmitter2) {
    this.emitter.on(TASK_EVENT, (taskInput: RemoteTask) => {
      void this.process(taskInput);
    });
  }

  /** Register a step handler by name (the worker side, in this same process). */
  handle(name: string, fn: StepHandler): void {
    this.handlers.set(name, fn);
  }

  async dispatch(task: RemoteTask): Promise<void> {
    this.emitter.emit(TASK_EVENT, task);
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.emitter.on(RESULT_EVENT, (result: StepResult) => {
      void handler(result);
    });
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.emitter.on(HEARTBEAT_EVENT, (beat: Heartbeat) => {
      void handler(beat);
    });
  }

  async publishControl(msg: ControlMessage): Promise<void> {
    this.emitter.emit(CONTROL_EVENT, msg);
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.emitter.on(CONTROL_EVENT, (msg: ControlMessage) => handler(msg));
  }

  private async process(task: RemoteTask): Promise<void> {
    const handler = this.handlers.get(task.name);
    if (!handler) return; // another subscriber may own this step name — stay silent, don't fail it
    const result = await runStepHandler(task, handler);
    // Emit the result on a later tick: a durable `ctx.call` suspends the run right after dispatch,
    // so the result must land AFTER that unwinds (else the resume re-enters mid-suspend).
    setImmediate(() => this.emitter.emit(RESULT_EVENT, result));
  }
}
