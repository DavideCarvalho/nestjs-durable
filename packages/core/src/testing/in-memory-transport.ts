import type { Heartbeat, RemoteTask, StepResult, Transport } from '../interfaces';

type Handler = (input: unknown) => Promise<unknown>;

/**
 * An in-process `Transport` for tests and local development: registered handlers stand in
 * for remote workers, so a whole cross-app workflow runs in a single process.
 */
export class InMemoryTransport implements Transport {
  private readonly handlers = new Map<string, Handler>();
  private resultHandler?: (result: StepResult) => Promise<void>;
  private heartbeatHandler?: (beat: Heartbeat) => Promise<void>;

  /** Register a fake worker handler for a step name. */
  handle(name: string, fn: Handler): void {
    this.handlers.set(name, fn);
  }

  async dispatch(task: RemoteTask): Promise<void> {
    const handler = this.handlers.get(task.name);
    if (!this.resultHandler) throw new Error('no result handler registered');
    if (!handler) {
      await this.resultHandler({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'failed',
        error: { message: `no handler for ${task.name}`, retryable: false },
      });
      return;
    }
    try {
      const output = await handler(task.input);
      await this.resultHandler({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output,
      });
    } catch (err) {
      await this.resultHandler({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'failed',
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.heartbeatHandler = handler;
  }
}
