import type { StepResult } from '@dudousxd/nestjs-durable-core';

/**
 * How a step worker sends its results back, with the same wire behaviour as `BullMQTransport`'s
 * `publishResult` / `publishReply` (and the Python SDK's `ResultPublisher`):
 *
 * 1. **Routed reply.** A task stamped `replyTo` (an engine instance id) has its workflow body parked
 *    in that instance's memory. While the instance's alive key `<prefix>:reply-alive:<id>` exists
 *    (read at most once a second per instance), the result goes to `<prefix>-results-to-<id>`, a
 *    queue only that instance consumes, so it resumes the parked body instead of another engine
 *    replaying it.
 * 2. **Result batches.** While an engine consumes `<prefix>-results-batch` (re-checked every 5 s),
 *    results that finish while one batch is being published share the next job.
 * 3. **Shared results.** `<prefix>-results`, one job per result, for older engines or when 1 and 2
 *    fail.
 *
 * Older engines ignore `replyTo` and never consume the batch queue, so this stays wire-compatible.
 */

/** Same as the transport's RESULT_JOB_OPTIONS: the engine retries a result job it failed to apply. */
export const RESULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 500 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;
export const RESULT_BATCH_MAX = 256;
const BATCH_CONSUMERS_TTL_MS = 5_000;
const REPLY_ALIVE_TTL_MS = 1_000;

export interface PublisherQueue {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  /** BullMQ's `Queue.getWorkersCount` (absent on a fake: then batches stay off). */
  getWorkersCount?(): Promise<number>;
}

export interface PublisherRedis {
  exists(key: string): Promise<number>;
}

export function replyQueueName(prefix: string, instanceId: string): string {
  return `${prefix}-results-to-${instanceId.replace(/[^A-Za-z0-9_.@-]/g, '-')}`;
}

export function replyAliveKey(prefix: string, instanceId: string): string {
  return `${prefix}:reply-alive:${instanceId}`;
}

interface Outbox {
  entries: { result: StepResult; resolve: (sent: boolean) => void }[];
  publishing: boolean;
}

export class ResultPublisher {
  private readonly queues = new Map<string, PublisherQueue>();
  private readonly outboxes = new Map<string, Outbox>();
  private readonly alive = new Map<string, { alive: boolean; at: number }>();
  private batchConsumers: { consumed: boolean; at: number } | undefined;
  private batchConsumersRead: Promise<boolean> | undefined;
  private readonly resultsName: string;
  private readonly batchesName: string;

  constructor(
    private readonly prefix: string,
    private readonly makeQueue: (name: string) => PublisherQueue,
    /** Read lazily: the runner's Redis client may connect after the publisher is built. */
    private readonly redis: () => PublisherRedis | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.resultsName = `${prefix}-results`;
    this.batchesName = `${prefix}-results-batch`;
  }

  queue(name: string): PublisherQueue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = this.makeQueue(name);
      this.queues.set(name, queue);
    }
    return queue;
  }

  async publish(result: StepResult, replyTo?: string): Promise<void> {
    if (typeof replyTo === 'string' && replyTo && (await this.publishReply(result, replyTo)))
      return;
    if ((await this.batchesConsumed()) && (await this.enqueue(this.batchesName, result))) return;
    await this.queue(this.resultsName).add('result', result, RESULT_JOB_OPTIONS);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }

  private async publishReply(result: StepResult, replyTo: string): Promise<boolean> {
    const redis = this.redis();
    if (!redis || !(await this.replyAlive(redis, replyTo))) return false;
    return this.enqueue(replyQueueName(this.prefix, replyTo), result);
  }

  private async replyAlive(redis: PublisherRedis, id: string): Promise<boolean> {
    const known = this.alive.get(id);
    if (known && this.now() - known.at < REPLY_ALIVE_TTL_MS) return known.alive;
    let alive = false;
    try {
      alive = (await redis.exists(replyAliveKey(this.prefix, id))) === 1;
    } catch {
      // Unknown liveness: use the shared results.
    }
    this.alive.set(id, { alive, at: this.now() });
    return alive;
  }

  private async batchesConsumed(): Promise<boolean> {
    const known = this.batchConsumers;
    if (known && this.now() - known.at < BATCH_CONSUMERS_TTL_MS) return known.consumed;
    this.batchConsumersRead ??= (async () => {
      let consumed = false;
      try {
        const queue = this.queue(this.batchesName);
        consumed = queue.getWorkersCount ? (await queue.getWorkersCount()) > 0 : false;
      } catch {
        // A refused CLIENT LIST answers no: one job per result.
      }
      this.batchConsumers = { consumed, at: this.now() };
      this.batchConsumersRead = undefined;
      return consumed;
    })();
    return this.batchConsumersRead;
  }

  /** Resolves true once `result` is published on `queueName`, false if its batch failed. */
  private enqueue(queueName: string, result: StepResult): Promise<boolean> {
    let outbox = this.outboxes.get(queueName);
    if (!outbox) {
      outbox = { entries: [], publishing: false };
      this.outboxes.set(queueName, outbox);
    }
    const box = outbox;
    return new Promise<boolean>((resolve) => {
      box.entries.push({ result, resolve });
      if (!box.publishing) void this.drain(queueName, box);
    });
  }

  private async drain(queueName: string, outbox: Outbox): Promise<void> {
    outbox.publishing = true;
    try {
      while (outbox.entries.length > 0) {
        const batch = outbox.entries.splice(0, RESULT_BATCH_MAX);
        let sent = true;
        try {
          // The batch queue's consumer reads only `{ results }`; a reply queue takes both shapes.
          if (batch.length === 1 && queueName !== this.batchesName) {
            await this.queue(queueName).add('result', batch[0]?.result, RESULT_JOB_OPTIONS);
          } else {
            await this.queue(queueName).add(
              'results',
              { results: batch.map((entry) => entry.result) },
              RESULT_JOB_OPTIONS,
            );
          }
        } catch {
          sent = false;
        }
        for (const entry of batch) entry.resolve(sent);
      }
    } finally {
      outbox.publishing = false;
    }
  }
}
