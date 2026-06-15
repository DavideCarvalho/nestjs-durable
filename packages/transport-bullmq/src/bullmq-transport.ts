import {
  type ControlMessage,
  type ControlPlane,
  type Heartbeat,
  type RemoteTask,
  type StepHandler,
  type StepResult,
  type Transport,
  type WorkflowDecision,
  type WorkflowTask,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

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
export class BullMQTransport implements Transport, ControlPlane {
  private readonly connection: ConnectionOptions;
  private readonly group?: string;
  private readonly prefix: string;
  private readonly handlers = new Map<string, StepHandler>();
  private readonly queues = new Map<string, Queue>();
  private taskWorker?: Worker;
  private resultsWorker?: Worker;
  private decisionsWorker?: Worker;
  // Control plane runs over Redis pub/sub (not a queue): every instance gets every message, which
  // is what live-tail + cancellation need. Subscribe needs its own connection (it blocks the client).
  private controlPub?: Redis;
  private controlSub?: Redis;
  // Heartbeats also ride Redis pub/sub: a worker on the long-step path beats so the engine on
  // another pod keeps the liveness window open (the in-memory `timeoutMs` path).
  private heartbeatPub?: Redis;
  private heartbeatSub?: Redis;

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

  private decisionsName(): string {
    return `${this.prefix}-decisions`;
  }

  /** engine → workflow worker: a WorkflowTask on the group's task queue (same queue a Python workflow
   *  worker consumes via `<prefix>-tasks-<group>`). The decision comes back on `<prefix>-decisions`. */
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    await this.queue(this.tasksName(task.group)).add('workflow', task, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** workflow worker → engine: consume replayed decisions. Starts the consumer on first call. */
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    if (this.decisionsWorker) return;
    this.decisionsWorker = new Worker(
      this.decisionsName(),
      (job) => handler(job.data as WorkflowDecision),
      { connection: this.workerConnection() },
    );
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

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    if (this.heartbeatSub) return; // one subscription per transport
    this.heartbeatSub = this.redis();
    void this.heartbeatSub.subscribe(this.heartbeatChannel());
    this.heartbeatSub.on('message', (_channel, payload) => {
      try {
        void handler(JSON.parse(payload) as Heartbeat);
      } catch {
        /* ignore malformed heartbeats */
      }
    });
  }

  /** Worker side: publish a liveness heartbeat for an in-flight long step (resets the engine's
   *  `timeoutMs` window on whichever pod is awaiting it). */
  async heartbeat(beat: Heartbeat): Promise<void> {
    if (!this.heartbeatPub) this.heartbeatPub = this.redis();
    await this.heartbeatPub.publish(this.heartbeatChannel(), JSON.stringify(beat));
  }

  private controlChannel(): string {
    return `${this.prefix}-control`;
  }

  private heartbeatChannel(): string {
    return `${this.prefix}-heartbeat`;
  }

  /** A standalone Redis client from the same connection — duplicating a passed-in instance, or
   *  building one from options (pub/sub can't share BullMQ's worker connections). */
  private redis(): Redis {
    const c = this.connection;
    if (c instanceof Redis) return c.duplicate();
    return new Redis(c as RedisOptions);
  }

  async publishControl(msg: ControlMessage): Promise<void> {
    if (!this.controlPub) this.controlPub = this.redis();
    await this.controlPub.publish(this.controlChannel(), JSON.stringify(msg));
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    if (this.controlSub) return; // one subscription per transport
    this.controlSub = this.redis();
    void this.controlSub.subscribe(this.controlChannel());
    this.controlSub.on('message', (_channel, payload) => {
      try {
        handler(JSON.parse(payload) as ControlMessage);
      } catch {
        /* ignore malformed control messages */
      }
    });
  }

  /** Close all workers and queues so the process can exit. */
  async close(): Promise<void> {
    await this.taskWorker?.close();
    await this.resultsWorker?.close();
    await this.decisionsWorker?.close();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.controlPub?.disconnect();
    this.controlSub?.disconnect();
    this.heartbeatPub?.disconnect();
    this.heartbeatSub?.disconnect();
  }
}
