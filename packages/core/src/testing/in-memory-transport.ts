import type { Heartbeat, RemoteTask, StepResult, Transport } from '../interfaces';
import { type StepHandler, runStepHandler } from '../protocol';

/**
 * An in-process `Transport` for tests and local development: registered handlers stand in
 * for remote workers, so a whole cross-app workflow runs in a single process.
 */
export class InMemoryTransport implements Transport {
  private readonly handlers = new Map<string, StepHandler>();
  private resultHandler?: (result: StepResult) => Promise<void>;

  /** Register a fake worker handler for a step name. */
  handle(name: string, fn: StepHandler): void {
    this.handlers.set(name, fn);
  }

  async dispatch(task: RemoteTask): Promise<void> {
    if (!this.resultHandler) throw new Error('no result handler registered');
    await this.resultHandler(await runStepHandler(task, this.handlers.get(task.name)));
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {
    // In-process handlers run synchronously; there is no liveness to track.
  }
}
