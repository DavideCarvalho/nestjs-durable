import {
  type ControlMessage,
  type ControlPlane,
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

export interface EventEmitterTransportOptions {
  /**
   * Where a failing result/heartbeat handler is reported. Default `console.error`. A result whose
   * handler threw (a store error while settling the checkpoint) is redelivered with backoff until
   * {@link EventEmitterTransport.close} — the in-memory copy is the only one, as on a broker whose job
   * stays queued until it is settled.
   */
  onError?: (err: unknown) => void;
}

/** Backoff for redelivering a result whose handler failed: 100ms doubling, capped at 5s. */
const RESULT_RETRY_BASE_MS = 100;
const RESULT_RETRY_MAX_MS = 5_000;

/**
 * An in-process `Transport` backed by `@nestjs/event-emitter`'s `EventEmitter2`.
 *
 * Zero extra infrastructure: step handlers run in the same process, fully decoupled from the
 * workflow that calls them. Swap to a queue-backed transport (BullMQ/NATS) for true
 * cross-process or cross-language steps.
 */
export class EventEmitterTransport implements Transport, ControlPlane {
  private readonly handlers = new Map<string, StepHandler>();
  private readonly onError: (err: unknown) => void;
  private closed = false;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly emitter: EventEmitter2,
    options: EventEmitterTransportOptions = {},
  ) {
    this.onError =
      options.onError ?? ((err) => console.error('[EventEmitterTransport] handler failed', err));
    this.emitter.on(TASK_EVENT, (taskInput: RemoteTask) => {
      // runStepHandler already turns a handler throw into a failed result; anything else that
      // rejects here is reported, never left as an unhandled rejection.
      void this.process(taskInput).catch((err) => this.onError(err));
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
      this.settle(handler, result, 0);
    });
  }

  /**
   * Hand `result` to the engine; if settling fails, report it and try again with backoff. Called as
   * `void handler(result)`, a rejection (the store briefly unreachable while the checkpoint is
   * written) became an unhandled rejection — fatal under Node's default — and the result, whose only
   * copy lived in this call, was lost. The engine settles a step only while it is still pending, so a
   * retry after a partial write is safe. Retries stop once the transport is closed.
   */
  private settle(
    handler: (result: StepResult) => Promise<void>,
    result: StepResult,
    attempt: number,
  ): void {
    Promise.resolve()
      .then(() => handler(result))
      .catch((err) => {
        this.onError(err);
        if (this.closed) return;
        const delay = Math.min(RESULT_RETRY_BASE_MS * 2 ** attempt, RESULT_RETRY_MAX_MS);
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          this.settle(handler, result, attempt + 1);
        }, delay);
        timer.unref?.();
        this.retryTimers.add(timer);
      });
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.emitter.on(HEARTBEAT_EVENT, (beat: Heartbeat) => {
      // A lost beat only costs liveness for one interval; report it rather than crash the process.
      Promise.resolve()
        .then(() => handler(beat))
        .catch((err) => this.onError(err));
    });
  }

  /** Stop redelivering failed results (the module calls it on shutdown). Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
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
