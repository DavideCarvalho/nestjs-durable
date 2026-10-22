import { getEventListeners } from 'node:events';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { RemoteTask, StepResult } from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqsTransport } from './sqs-transport';

/**
 * An in-memory SQS with the semantics these cases depend on: a received message is invisible for its
 * visibility timeout and then redelivered (with a NEW receipt handle) unless deleted;
 * ChangeMessageVisibility / DeleteMessage act on the current receipt handle only.
 */
class FakeSqs {
  readonly queues = new Map<
    string,
    Array<{ id: number; body: string; invisibleUntil: number; receipt?: string; receives: number }>
  >();
  /** Called before every SendMessage — throw from it to make the send fail. */
  beforeSend: (queueUrl: string, body: string) => void = () => {};
  private seq = 0;

  queue(url: string) {
    let q = this.queues.get(url);
    if (!q) {
      q = [];
      this.queues.set(url, q);
    }
    return q;
  }

  put(url: string, body: string): void {
    this.queue(url).push({ id: this.seq++, body, invisibleUntil: 0, receives: 0 });
  }

  /** Bodies still on `url` (in flight or visible). */
  bodies(url: string): string[] {
    return this.queue(url).map((m) => m.body);
  }

  client(): SQSClient {
    const send = async (command: unknown, opts?: { abortSignal?: AbortSignal }) => {
      if (command instanceof GetQueueUrlCommand) {
        return { QueueUrl: `fake://${command.input.QueueName}` };
      }
      if (command instanceof SendMessageCommand) {
        const { QueueUrl, MessageBody } = command.input;
        this.beforeSend(QueueUrl as string, MessageBody as string);
        this.put(QueueUrl as string, MessageBody as string);
        return {};
      }
      if (command instanceof DeleteMessageCommand) {
        const q = this.queue(command.input.QueueUrl as string);
        const i = q.findIndex((m) => m.receipt === command.input.ReceiptHandle);
        if (i >= 0) q.splice(i, 1);
        return {};
      }
      if (command instanceof ChangeMessageVisibilityCommand) {
        const q = this.queue(command.input.QueueUrl as string);
        const m = q.find((x) => x.receipt === command.input.ReceiptHandle);
        if (m) m.invisibleUntil = Date.now() + (command.input.VisibilityTimeout ?? 0) * 1000;
        return {};
      }
      if (command instanceof ReceiveMessageCommand) {
        const { QueueUrl, MaxNumberOfMessages, VisibilityTimeout } = command.input;
        const deadline = Date.now() + 200;
        for (;;) {
          if (opts?.abortSignal?.aborted) throw new Error('aborted');
          const now = Date.now();
          const visible = this.queue(QueueUrl as string)
            .filter((m) => m.invisibleUntil <= now)
            .slice(0, MaxNumberOfMessages ?? 1);
          if (visible.length > 0 || now >= deadline) {
            return {
              Messages: visible.map((m) => {
                m.invisibleUntil = now + (VisibilityTimeout ?? 30) * 1000;
                m.receives += 1;
                m.receipt = `rh-${m.id}-${m.receives}`;
                return { Body: m.body, ReceiptHandle: m.receipt, MessageId: String(m.id) };
              }),
            };
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      throw new Error(`unexpected command ${(command as object).constructor.name}`);
    };
    return { send, destroy: () => {} } as unknown as SQSClient;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
}

const task = (stepId: string, over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: `run-${stepId}`,
  seq: 0,
  stepId,
  name: 'charge',
  group: 'payments',
  input: { stepId },
  attempt: 1,
  ...over,
});
const result = (stepId: string): StepResult => ({
  runId: `run-${stepId}`,
  seq: 0,
  stepId,
  status: 'completed',
  output: stepId,
});

const TASKS = 'fake://durable-tasks-payments';
const RESULTS = 'fake://durable-results';

const open: SqsTransport[] = [];
function transport(sqs: FakeSqs, opts: ConstructorParameters<typeof SqsTransport>[0] = {}) {
  const t = new SqsTransport({ client: sqs.client(), group: 'payments', ...opts });
  open.push(t);
  return t;
}
const unhandled: unknown[] = [];
const onUnhandled = (err: unknown) => unhandled.push(err);
process.on('unhandledRejection', onUnhandled);

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
  unhandled.splice(0);
});

describe('SqsTransport poll loops survive failures', () => {
  it('a throwing result handler is reported, its message left for redelivery, and the loop keeps consuming', async () => {
    const sqs = new FakeSqs();
    const errors: unknown[] = [];
    const t = transport(sqs, { onError: (err) => errors.push(err) });
    const delivered: string[] = [];
    t.onResult(async (r) => {
      if (r.stepId === 'bad') throw new Error('store unreachable');
      delivered.push(r.stepId);
    });
    sqs.put(RESULTS, JSON.stringify(result('bad')));
    sqs.put(RESULTS, JSON.stringify(result('good')));
    await until(() => delivered.includes('good'));
    expect(delivered).toEqual(['good']);
    expect(errors.length).toBeGreaterThan(0);
    // Not deleted: SQS redelivers it after the visibility timeout (and a redrive policy DLQs it).
    expect(sqs.bodies(RESULTS)).toEqual([JSON.stringify(result('bad'))]);
    expect(unhandled).toEqual([]);
  });

  it('a non-JSON task body is reported and left for the redrive policy; the next task still runs', async () => {
    const sqs = new FakeSqs();
    const errors: unknown[] = [];
    const t = transport(sqs, { onError: (err) => errors.push(err) });
    const ran: string[] = [];
    t.handle('charge', async (input: { stepId: string }) => {
      ran.push(input.stepId);
      return 'ok';
    });
    sqs.put(TASKS, 'not json {');
    sqs.put(TASKS, JSON.stringify(task('s1')));
    await until(() => ran.includes('s1') && sqs.bodies(RESULTS).length > 0);
    expect(ran).toEqual(['s1']);
    expect(errors.length).toBeGreaterThan(0);
    expect(sqs.bodies(TASKS)).toEqual(['not json {']);
    expect(unhandled).toEqual([]);
  });

  it('a failing result send is reported, the task left for redelivery, and the loop keeps consuming', async () => {
    const sqs = new FakeSqs();
    const errors: unknown[] = [];
    let failNext = true;
    sqs.beforeSend = (url) => {
      if (url === RESULTS && failNext) {
        failNext = false;
        throw new Error('SendMessage throttled');
      }
    };
    const t = transport(sqs, { onError: (err) => errors.push(err) });
    const ran: string[] = [];
    t.handle('charge', async (input: { stepId: string }) => {
      ran.push(input.stepId);
      return 'ok';
    });
    sqs.put(TASKS, JSON.stringify(task('s1')));
    sqs.put(TASKS, JSON.stringify(task('s2')));
    await until(() => sqs.bodies(RESULTS).length > 0 && ran.length >= 2);
    expect(errors.length).toBeGreaterThan(0);
    expect(ran).toEqual(['s1', 's2']);
    // s1's result was not sent, so its task is still on the queue for redelivery.
    expect(sqs.bodies(TASKS)).toEqual([JSON.stringify(task('s1'))]);
    expect(unhandled).toEqual([]);
  });
});

describe('SqsTransport backoff', () => {
  it('does not accumulate abort listeners across repeated failures', async () => {
    vi.useFakeTimers();
    try {
      const t = transport(new FakeSqs());
      const internals = t as unknown as { backoff(): Promise<void>; abort: AbortController };
      for (let i = 0; i < 20; i += 1) {
        const wait = internals.backoff();
        await vi.advanceTimersByTimeAsync(1_000);
        await wait;
      }
      expect(getEventListeners(internals.abort.signal, 'abort')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SqsTransport visibility', () => {
  it('keeps every received message invisible while it waits or runs, so none runs twice', async () => {
    const sqs = new FakeSqs();
    const ran: string[] = [];
    const make = () => {
      const t = transport(sqs, { visibilityTimeoutSec: 1 });
      t.handle('charge', async (input: { stepId: string }) => {
        ran.push(input.stepId);
        await sleep(1_500);
        return 'ok';
      });
      return t;
    };
    sqs.put(TASKS, JSON.stringify(task('s1')));
    sqs.put(TASKS, JSON.stringify(task('s2')));
    make();
    await sleep(100); // the first instance receives both
    make();
    await until(() => sqs.bodies(TASKS).length === 0, 8_000);
    await sleep(200);
    expect([...ran].sort()).toEqual(['s1', 's2']);
  }, 15_000);

  it('resolves a group taskQueueUrl once and caches it', async () => {
    const sqs = new FakeSqs();
    let calls = 0;
    const t = transport(sqs, {
      taskQueueUrl: async (group) => {
        calls += 1;
        return `fake://custom-${group}`;
      },
    });
    await t.dispatch(task('s1'));
    await t.dispatch(task('s2'));
    await t.dispatch(task('s3'));
    expect(calls).toBe(1);
    expect(sqs.bodies('fake://custom-payments')).toHaveLength(3);
  });
});
