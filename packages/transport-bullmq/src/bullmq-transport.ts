import {
  type Heartbeat,
  type RemoteTask,
  type StepHandler,
  type StepResult,
  type Transport,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';

export interface BullMQTransportOptions {
  /** ioredis connection options (or an IORedis instance). */
  connection: ConnectionOptions;
  /** The worker group this instance serves, required to register `handle()` consumers. */
  group?: string;
  /** Key prefix namespacing the durable queues. Defaults to `durable`. */
  prefix?: string;
}

/**
 * A queue-backed `Transport` over BullMQ/Redis — the path for true cross-process and
 * cross-language steps (e.g. a Python worker on the same queues). Steps are dispatched to a
 * per-group tasks queue; results come back on a shared results queue.
 *
 * Run one instance engine-side (consumes results) and one per worker process (registers
 * `handle()`s for its group). The wire payload is the documented `RemoteTask`/`StepResult` JSON,
 * so non-Node workers interoperate.
 */
export class BullMQTransport implements Transport {
  private readonly connection: ConnectionOptions;
  private readonly group?: string;
  private readonly prefix: string;
  private readonly handlers = new Map<string, StepHandler>();
  private readonly queues = new Map<string, Queue>();
  private taskWorker?: Worker;
  private resultsWorker?: Worker;

  constructor(options: BullMQTransportOptions) {
    this.connection = options.connection;
    this.group = options.group;
    this.prefix = options.prefix ?? 'durable';
  }

  // BullMQ queue names must not contain ':' (its Redis key separator), so use '-'.
  private tasksName(group: string): string {
    return `${this.prefix}-tasks-${group}`;
  }
  private resultsName(): string {
    return `${this.prefix}-results`;
  }

  /** Workers require `maxRetriesPerRequest: null`; preserve a passed-in IORedis instance as-is. */
  private workerConnection(): ConnectionOptions {
    if (this.connection && typeof this.connection === 'object' && !('options' in this.connection)) {
      return { ...this.connection, maxRetriesPerRequest: null };
    }
    return this.connection;
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async dispatch(task: RemoteTask): Promise<void> {
    await this.queue(this.tasksName(task.group)).add('task', task, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** Register a step handler (worker side). Starts the group's task consumer on first call. */
  handle(name: string, fn: StepHandler): void {
    if (!this.group) throw new Error('BullMQTransport needs a `group` to register handlers');
    this.handlers.set(name, fn);
    if (!this.taskWorker) {
      this.taskWorker = new Worker(this.tasksName(this.group), (job) => this.runTask(job.data), {
        connection: this.workerConnection(),
      });
    }
  }

  private async runTask(task: RemoteTask): Promise<void> {
    const result = await runStepHandler(task, this.handlers.get(task.name));
    await this.queue(this.resultsName()).add('result', result, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultsWorker = new Worker(this.resultsName(), (job) => handler(job.data as StepResult), {
      connection: this.workerConnection(),
    });
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {
    // Heartbeats are not modelled over BullMQ yet; the queue's own stalled-job recovery applies.
  }

  /** Close all workers and queues so the process can exit. */
  async close(): Promise<void> {
    await this.taskWorker?.close();
    await this.resultsWorker?.close();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
