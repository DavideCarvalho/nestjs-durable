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

/** Resolve a group's tasks queue URL. Sync or async; resolved once per group and cached (a rejected
 *  resolution is not cached — the next call asks again). */
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
   * `autoCreate`). Return value is awaited and cached per group.
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
  /**
   * Visibility timeout for a received task, in seconds. Default 60. Every message this instance has
   * received — the one running and the ones of the same batch waiting behind it — is kept invisible by
   * re-extending it (`ChangeMessageVisibility`) every third of this, so a step may run longer; only a
   * crashed instance's messages reappear, after at most this long.
   */
  visibilityTimeoutSec?: number;
  /**
   * Where a transport failure is reported: a failing receive, a result handler that throws, a result
   * send that fails, a message whose body isn't JSON. The message involved is NOT deleted: SQS
   * redelivers it after its visibility timeout, and a queue redrive policy (`maxReceiveCount` → DLQ)
   * moves one that keeps failing aside. Default `console.error`.
   */
  onError?: (err: unknown) => void;
}

/** A received message, as the poll loops use it. */
interface Received {
  Body?: string | undefined;
  ReceiptHandle?: string | undefined;
  MessageId?: string | undefined;
  MessageAttributes?: Record<string, unknown> | undefined;
}

/** The results queue's visibility timeout (seconds). */
const RESULT_VISIBILITY_SEC = 30;

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
  private readonly onError: (err: unknown) => void;

  private readonly handlers = new Map<string, StepHandler>();
  private readonly urlCache = new Map<string, string>();
  /** `taskQueueUrl` resolutions per group (the promise, so concurrent dispatches share one call). */
  private readonly groupUrlCache = new Map<string, Promise<string>>();
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
    this.onError = options.onError ?? ((err) => console.error('[SqsTransport]', err));
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
    const resolver = this.taskQueueUrlResolver;
    if (!resolver) return this.resolveByName(`${this.prefix}-tasks-${group}`);
    let url = this.groupUrlCache.get(group);
    if (!url) {
      url = Promise.resolve()
        .then(() => resolver(group))
        .catch((err) => {
          this.groupUrlCache.delete(group);
          throw err;
        });
      this.groupUrlCache.set(group, url);
    }
    return url;
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

  /**
   * Receive a batch and hand each message to `each`, one at a time, never letting a failure escape:
   * a throw is reported through `onError` and its message is left on the queue (SQS redelivers it
   * after the visibility timeout; a redrive policy DLQs one that keeps failing). Every message of the
   * batch is kept invisible until it is handled (see {@link holdVisible}), so the ones waiting behind a
   * slow handler are never redelivered to another consumer meanwhile.
   */
  private async pollLoop(
    queueUrl: () => Promise<string>,
    visibilitySec: number,
    each: (QueueUrl: string, msg: Received) => Promise<void>,
  ): Promise<void> {
    while (this.running) {
      let QueueUrl: string;
      try {
        QueueUrl = await queueUrl();
      } catch (err) {
        if (!this.running) return;
        this.onError(err);
        await this.backoff();
        continue;
      }
      const messages = await this.receive(QueueUrl, visibilitySec);
      const pending = new Set<Received>(messages);
      const stopHolding = this.holdVisible(QueueUrl, pending, visibilitySec);
      try {
        for (const msg of messages) {
          if (!this.running) break; // close(): what is left reappears after its visibility timeout
          try {
            if (this.shouldSkip(msg)) {
              // Not ours (shared queue): release immediately so the legacy consumer can take it.
              pending.delete(msg);
              await this.release(QueueUrl, msg.ReceiptHandle);
              continue;
            }
            await each(QueueUrl, msg);
          } catch (err) {
            this.onError(err);
          } finally {
            pending.delete(msg);
          }
        }
      } finally {
        stopHolding();
      }
    }
  }

  /**
   * Keep `messages` invisible while they wait or run: every third of the visibility timeout, extend
   * each one still in the set back to the full timeout. Returns the stop function.
   */
  private holdVisible(
    QueueUrl: string,
    messages: Set<Received>,
    visibilitySec: number,
  ): () => void {
    if (messages.size === 0) return () => {};
    const intervalMs = Math.max(200, Math.floor((visibilitySec * 1000) / 3));
    let round: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (round) return;
      round = Promise.all(
        [...messages].map((msg) =>
          msg.ReceiptHandle
            ? this.client
                .send(
                  new ChangeMessageVisibilityCommand({
                    QueueUrl,
                    ReceiptHandle: msg.ReceiptHandle,
                    VisibilityTimeout: visibilitySec,
                  }),
                )
                .then(() => undefined)
                .catch((err) => {
                  if (this.running) this.onError(err);
                })
            : undefined,
        ),
      ).then(() => {
        round = undefined;
      });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private parse<T>(msg: Received): T {
    try {
      return JSON.parse(msg.Body ?? '') as T;
    } catch {
      throw new Error(
        `[SqsTransport] message ${msg.MessageId ?? '?'} has a non-JSON body; leaving it for the queue's redrive policy`,
      );
    }
  }

  private pollTasks(group: string): Promise<void> {
    return this.pollLoop(
      () => this.tasksUrl(group),
      this.visibilityTimeoutSec,
      async (QueueUrl, msg) => {
        const task = this.parse<RemoteTask>(msg);
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
      },
    );
  }

  private pollResults(handler: (result: StepResult) => Promise<void>): Promise<void> {
    return this.pollLoop(
      () => this.resultsUrl(),
      RESULT_VISIBILITY_SEC,
      async (QueueUrl, msg) => {
        await handler(this.parse<StepResult>(msg));
        await this.del(QueueUrl, msg.ReceiptHandle);
      },
    );
  }

  private backoff(): Promise<void> {
    return new Promise((r) => {
      const timer = setTimeout(r, 1000);
      this.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        r(undefined);
      });
    });
  }

  /** One long-poll receive. Swallows the abort thrown on `close()`; logs and backs off otherwise. */
  private async receive(QueueUrl: string, visibility: number): Promise<Received[]> {
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
      this.onError(err);
      await this.backoff();
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
