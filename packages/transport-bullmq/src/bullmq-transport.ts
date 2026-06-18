import { hostname } from 'node:os';
import {
  type ControlMessage,
  type ControlPlane,
  type GroupHealth,
  type Heartbeat,
  type RemoteTask,
  type StepHandler,
  type StepResult,
  type Transport,
  type WorkerHeartbeat,
  type WorkflowDecision,
  type WorkflowStepEvent,
  type WorkflowTask,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

// Worker liveness heartbeat: a worker stamps a TTL'd key while it's consuming; the key expiring is
// the "this worker is gone/stalled" signal a monitor watches. TTL comfortably exceeds the interval
// so one slow refresh doesn't flap. Mirrors the Python SDK's `durable-worker-heartbeat:` key, so a
// mixed-language group (TS engine-side + Python workers) reports all its workers under one scan.
const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const WORKER_HEARTBEAT_TTL_SECONDS = 35;

export interface BullMQTransportOptions {
  /** ioredis connection options (or an IORedis instance). */
  connection: ConnectionOptions;
  /** The worker group this instance serves, required to register `handle()` consumers. */
  group?: string;
  /** Key prefix namespacing the durable queues. Defaults to `durable`. */
  prefix?: string;
  /** Stable id for this worker process in heartbeats. Defaults to `ts-<hostname>-<pid>`. */
  instanceId?: string;
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
  private readonly group?: string | undefined;
  private readonly prefix: string;
  private readonly handlers = new Map<string, StepHandler>();
  private readonly queues = new Map<string, Queue>();
  private taskWorker?: Worker;
  private resultsWorker?: Worker;
  private decisionsWorker?: Worker;
  private stepEventsWorker?: Worker;
  // Control plane runs over Redis pub/sub (not a queue): every instance gets every message, which
  // is what live-tail + cancellation need. Subscribe needs its own connection (it blocks the client).
  private controlPub?: Redis;
  private controlSub?: Redis;
  // Heartbeats also ride Redis pub/sub: a worker on the long-step path beats so the engine on
  // another pod keeps the liveness window open (the in-memory `timeoutMs` path).
  private heartbeatPub?: Redis;
  private heartbeatSub?: Redis;
  // Worker liveness (distinct from the long-step `heartbeat()` pub/sub above): a TTL'd key refreshed
  // on a timer while this instance is acting as a worker, + a client for reading peers' keys.
  private readonly instanceId: string;
  private workerHeartbeatTimer?: ReturnType<typeof setInterval>;
  private workerHeartbeatRedis?: Redis;

  constructor(options: BullMQTransportOptions) {
    this.connection = options.connection;
    this.group = options.group;
    this.prefix = options.prefix ?? 'durable';
    this.instanceId = options.instanceId ?? `ts-${hostname()}-${process.pid}`;
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

  private stepEventsName(): string {
    return `${this.prefix}-step-events`;
  }

  /** workflow worker → engine: stream a local step's lifecycle. Point-to-point on its own queue, so a
   *  single engine instance consumes each event and checkpoints it once (no cross-pod duplicate writes). */
  async dispatchStepEvent(event: WorkflowStepEvent): Promise<void> {
    await this.queue(this.stepEventsName()).add('stepEvent', event, {
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** engine ← workflow worker: consume streamed step lifecycle events. Starts the consumer on first call. */
  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    if (this.stepEventsWorker) return;
    this.stepEventsWorker = new Worker(
      this.stepEventsName(),
      (job) => handler(job.data as WorkflowStepEvent),
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
      // This instance is now a worker for `group` — start stamping its liveness heartbeat.
      this.startWorkerHeartbeat(this.group);
    }
  }

  private workerHeartbeatKey(group: string, instanceId: string): string {
    return `${this.prefix}-worker-heartbeat:${group}:${instanceId}`;
  }

  /** Lazily-created standalone client for the worker-heartbeat keys (writes + scans), reused so a
   *  worker doesn't open a fresh connection per beat/read. */
  private workerRedis(): Redis {
    if (!this.workerHeartbeatRedis) this.workerHeartbeatRedis = this.redis();
    return this.workerHeartbeatRedis;
  }

  /** Refresh this worker's TTL'd liveness key on an interval until `close()`. Best-effort: a failed
   *  refresh is swallowed (the key then expires, and that gap is itself the signal). The first beat
   *  fires immediately so a freshly-started worker is visible without waiting a full interval. */
  private startWorkerHeartbeat(group: string): void {
    if (this.workerHeartbeatTimer) return;
    const client = this.workerRedis();
    const key = this.workerHeartbeatKey(group, this.instanceId);
    const beat = () => {
      void client.set(key, String(Date.now()), 'EX', WORKER_HEARTBEAT_TTL_SECONDS).catch(() => {});
    };
    beat();
    this.workerHeartbeatTimer = setInterval(beat, WORKER_HEARTBEAT_INTERVAL_MS);
    // Don't keep the event loop alive just for the heartbeat (a worker should exit when idle-closing).
    this.workerHeartbeatTimer.unref?.();
  }

  /** Distinct groups with a live worker heartbeat, discovered by scanning the heartbeat keyspace.
   *  A key is `<prefix>-worker-heartbeat:<group>:<instanceId>` and group/instanceId carry no `:`,
   *  so the group is the segment between the fixed prefix and the next `:`. */
  async listWorkerGroups(): Promise<string[]> {
    const client = this.workerRedis();
    const prefix = `${this.prefix}-worker-heartbeat:`;
    const groups = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const sep = rest.indexOf(':');
        const group = sep === -1 ? rest : rest.slice(0, sep);
        if (group) groups.add(group);
      }
    } while (cursor !== '0');
    return [...groups];
  }

  async groupHealth(group: string): Promise<GroupHealth> {
    const counts = await this.queue(this.tasksName(group)).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
    );
    const depth = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    return { group, depth, liveWorkers: await this.listLiveWorkers(group) };
  }

  /** Live workers for `group`: SCAN the heartbeat keys (never KEYS — it blocks Redis) and read each.
   *  A returned key is live by definition (the TTL hasn't expired). Tolerates both this SDK's
   *  millisecond stamp and the Python SDK's seconds stamp when reporting `lastBeatAt`. */
  private async listLiveWorkers(group: string): Promise<WorkerHeartbeat[]> {
    const client = this.workerRedis();
    const match = this.workerHeartbeatKey(group, '*');
    const prefix = this.workerHeartbeatKey(group, '');
    const workers: WorkerHeartbeat[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const raw = await client.get(key);
        const n = raw == null ? Number.NaN : Number(raw);
        // Python stamps epoch SECONDS, this SDK stamps MILLISECONDS — normalize to ms.
        const lastBeatAt = Number.isNaN(n) ? 0 : n < 1e12 ? n * 1000 : n;
        workers.push({ group, instanceId: key.slice(prefix.length), lastBeatAt });
      }
    } while (cursor !== '0');
    return workers;
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
    if (this.workerHeartbeatTimer) clearInterval(this.workerHeartbeatTimer);
    await this.taskWorker?.close();
    await this.resultsWorker?.close();
    await this.decisionsWorker?.close();
    await this.stepEventsWorker?.close();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.controlPub?.disconnect();
    this.controlSub?.disconnect();
    this.heartbeatPub?.disconnect();
    this.heartbeatSub?.disconnect();
    this.workerHeartbeatRedis?.disconnect();
  }
}
