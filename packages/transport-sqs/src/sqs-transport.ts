import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  type SQSClientConfig,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  type Heartbeat,
  type RemoteTask,
  type StepHandler,
  type StepResult,
  type Transport,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';

/** Resolve a group's tasks queue URL. Sync or async; resolved once and cached. */
export type QueueUrlResolver = (group: string) => string | Promise<string>;

export interface SqsTransportOptions {
  /**
   * Reuse an existing SQS client (recommended — share the app's). When omitted, one is built
   * from `clientConfig` and destroyed on `close()`.
   */
  client?: SQSClient;
  /** Used only when `client` is omitted — e.g. `{ region, endpoint, credentials }` for ElasticMQ. */
  clientConfig?: SQSClientConfig;

  /** The worker group this instance serves. Required to register `handle()` consumers. */
  group?: string;

  /**
   * Map a group → an **existing** tasks queue URL. This is the seam for reusing queues you already
   * have (e.g. `extraction`, `ingestion`) instead of letting the transport mint its own. When
   * omitted, the transport resolves `${prefix}-tasks-${group}` by name (and creates it if
   * `autoCreate`). Return value is awaited and cached.
   */
  taskQueueUrl?: QueueUrlResolver;
  /**
   * The results queue URL (worker → engine). A literal URL or a resolver. When omitted, the
   * transport resolves `${prefix}-results` by name (and creates it if `autoCreate`).
   */
  resultsQueueUrl?: string | (() => string | Promise<string>);

  /** Prefix for the fallback `${prefix}-tasks-*` / `${prefix}-results` names. Default `durable`. */
  prefix?: string;
  /**
   * Create the fallback-named queues on first use if they don't exist (handy for ElasticMQ / dev).
   * Ignored for queues you supply via `taskQueueUrl` / `resultsQueueUrl` — those must already exist.
   */
  autoCreate?: boolean;

  /**
   * When set, durable messages carry this SQS message attribute and pollers **skip** messages
   * that lack it (releasing them for a co-resident legacy consumer). Enables sharing one physical
   * queue with a non-durable consumer — but only if that consumer likewise ignores tagged messages.
   * Leave unset for the clean case: a queue dedicated to durable traffic.
   */
  marker?: string;

  /** SQS receive long-poll seconds (0–20). Default 20. */
  waitTimeSeconds?: number;
  /** Visibility timeout for an in-flight task, in seconds. Must exceed the step's runtime. Default 60. */
  visibilityTimeoutSec?: number;
}

/**
 * An SQS-backed `Transport` — dispatch remote steps over Amazon SQS (or ElasticMQ). Unlike the
 * BullMQ transport, it does **not** mint its own queue names: pass `taskQueueUrl` / `resultsQueueUrl`
 * to ride the queues you already operate. The wire payload is the documented `RemoteTask` /
 * `StepResult` JSON, so non-Node workers on the same queues interoperate.
 *
 * Run one instance engine-side (calls `onResult`, dispatches tasks) and one per worker process
 * (calls `handle()` for its group). SQS is at-least-once: a task whose process crashes before the
 * result is sent reappears after the visibility timeout (durable retry); a duplicate `StepResult`
 * is harmless because the engine resolves a step's `pending` exactly once by `stepId`.
 */
export class SqsTransport implements Transport {
  private readonly client: SQSClient;
  private readonly ownsClient: boolean;
  private readonly group?: string | undefined;
  private readonly prefix: string;
  private readonly autoCreate: boolean;
  private readonly marker?: string | undefined;
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeoutSec: number;
  private readonly taskQueueUrlResolver?: QueueUrlResolver | undefined;
  private readonly resultsQueueUrlOption?: string | (() => string | Promise<string>) | undefined;

  private readonly handlers = new Map<string, StepHandler>();
  private readonly urlCache = new Map<string, string>();
  private running = true;
  private readonly abort = new AbortController();
  private taskLoop?: Promise<void>;
  private resultLoop?: Promise<void>;

  constructor(options: SqsTransportOptions) {
    this.client = options.client ?? new SQSClient(options.clientConfig ?? {});
    this.ownsClient = !options.client;
    this.group = options.group;
    this.prefix = options.prefix ?? 'durable';
    this.autoCreate = options.autoCreate ?? false;
    this.marker = options.marker;
    this.waitTimeSeconds = options.waitTimeSeconds ?? 20;
    this.visibilityTimeoutSec = options.visibilityTimeoutSec ?? 60;
    this.taskQueueUrlResolver = options.taskQueueUrl;
    this.resultsQueueUrlOption = options.resultsQueueUrl;
  }

  // ── queue resolution ───────────────────────────────────────────────────────────────────────

  private async resolveByName(name: string): Promise<string> {
    const cached = this.urlCache.get(name);
    if (cached) return cached;
    let url: string;
    try {
      const out = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      url = out.QueueUrl as string;
    } catch (err) {
      if (this.autoCreate) {
        const created = await this.client.send(new CreateQueueCommand({ QueueName: name }));
        url = created.QueueUrl as string;
      } else {
        throw err;
      }
    }
    this.urlCache.set(name, url);
    return url;
  }

  private async tasksUrl(group: string): Promise<string> {
    if (this.taskQueueUrlResolver) return this.taskQueueUrlResolver(group);
    return this.resolveByName(`${this.prefix}-tasks-${group}`);
  }

  private async resultsUrl(): Promise<string> {
    const opt = this.resultsQueueUrlOption;
    if (typeof opt === 'string') return opt;
    if (typeof opt === 'function') return opt();
    return this.resolveByName(`${this.prefix}-results`);
  }

  // ── engine → worker ────────────────────────────────────────────────────────────────────────

  async dispatch(task: RemoteTask): Promise<void> {
    const QueueUrl = await this.tasksUrl(task.group);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(task),
        MessageAttributes: this.marker
          ? { [this.marker]: { DataType: 'String', StringValue: '1' } }
          : undefined,
      }),
    );
  }

  // ── worker → engine ────────────────────────────────────────────────────────────────────────

  /** Register a step handler (worker side). Starts the group's task consumer on first call. */
  handle(name: string, fn: StepHandler): void {
    if (!this.group) throw new Error('SqsTransport needs a `group` to register handlers');
    this.handlers.set(name, fn);
    if (!this.taskLoop) this.taskLoop = this.pollTasks(this.group);
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    if (!this.resultLoop) this.resultLoop = this.pollResults(handler);
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {
    // Not modelled over SQS; the queue's visibility-timeout redelivery is the liveness mechanism.
  }

  // ── polling loops ──────────────────────────────────────────────────────────────────────────

  private async pollTasks(group: string): Promise<void> {
    const QueueUrl = await this.tasksUrl(group);
    while (this.running) {
      const messages = await this.receive(QueueUrl, this.visibilityTimeoutSec);
      for (const msg of messages) {
        if (this.shouldSkip(msg)) {
          // Not ours (shared queue): release immediately so the legacy consumer can take it.
          await this.release(QueueUrl, msg.ReceiptHandle);
          continue;
        }
        const task = JSON.parse(msg.Body ?? '{}') as RemoteTask;
        const result = await runStepHandler(task, this.handlers.get(task.name));
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: await this.resultsUrl(),
            MessageBody: JSON.stringify(result),
            MessageAttributes: this.marker
              ? { [this.marker]: { DataType: 'String', StringValue: '1' } }
              : undefined,
          }),
        );
        await this.del(QueueUrl, msg.ReceiptHandle);
      }
    }
  }

  private async pollResults(handler: (result: StepResult) => Promise<void>): Promise<void> {
    const QueueUrl = await this.resultsUrl();
    while (this.running) {
      const messages = await this.receive(QueueUrl, 30);
      for (const msg of messages) {
        if (this.shouldSkip(msg)) {
          await this.release(QueueUrl, msg.ReceiptHandle);
          continue;
        }
        await handler(JSON.parse(msg.Body ?? '{}') as StepResult);
        await this.del(QueueUrl, msg.ReceiptHandle);
      }
    }
  }

  /** One long-poll receive. Swallows the abort thrown on `close()`; logs and backs off otherwise. */
  private async receive(QueueUrl: string, visibility: number) {
    try {
      const out = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.waitTimeSeconds,
          VisibilityTimeout: visibility,
          MessageAttributeNames: this.marker ? ['All'] : undefined,
        }),
        { abortSignal: this.abort.signal },
      );
      return out.Messages ?? [];
    } catch (err) {
      if (!this.running) return [];
      console.error('[SqsTransport] receive failed', err);
      await new Promise((r) => setTimeout(r, 1000));
      return [];
    }
  }

  private shouldSkip(msg: { MessageAttributes?: Record<string, unknown> | undefined }): boolean {
    return !!this.marker && !msg.MessageAttributes?.[this.marker];
  }

  private async del(QueueUrl: string, ReceiptHandle?: string): Promise<void> {
    if (!ReceiptHandle) return;
    await this.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle }));
  }

  private async release(QueueUrl: string, ReceiptHandle?: string): Promise<void> {
    if (!ReceiptHandle) return;
    await this.client
      .send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle, VisibilityTimeout: 0 }))
      .catch(() => {});
  }

  /** Stop the pollers and (if we created it) destroy the SQS client so the process can exit. */
  async close(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await Promise.allSettled([this.taskLoop, this.resultLoop]);
    if (this.ownsClient) this.client.destroy();
  }
}
