import type { StepResult } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import {
  type PublisherQueue,
  RESULT_BATCH_MAX,
  ResultPublisher,
  replyAliveKey,
  replyQueueName,
} from './result-publisher';

type Sent = { queue: string; name: string; data: unknown };

function setup(
  opts: { alive?: string[]; batchConsumers?: number; failQueues?: string[]; redisDown?: boolean } = {},
) {
  const sent: Sent[] = [];
  let exists = 0;
  let gate: Promise<void> = Promise.resolve();
  let open = () => {};
  const hold = () => {
    gate = new Promise((r) => {
      open = r;
    });
  };
  const makeQueue = (queue: string): PublisherQueue => ({
    async add(name, data) {
      await gate;
      if (opts.failQueues?.includes(queue)) throw new Error('refused');
      sent.push({ queue, name, data });
    },
    async close() {},
    getWorkersCount: async () => (queue.endsWith('-results-batch') ? (opts.batchConsumers ?? 0) : 0),
  });
  const alive = new Set(opts.alive ?? []);
  const redis = {
    async exists(key: string) {
      exists++;
      if (opts.redisDown) throw new Error('down');
      return alive.has(key) ? 1 : 0;
    },
  };
  let now = 0;
  const pub = new ResultPublisher('durable', makeQueue, () => redis, () => now);
  return {
    pub,
    sent,
    hold,
    release: () => open(),
    exists: () => exists,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const result = (seq: number): StepResult =>
  ({ runId: 'r', seq, stepId: `s${seq}`, status: 'completed', output: seq }) as StepResult;

describe('ResultPublisher', () => {
  it('names reply queues like BullMQTransport', () => {
    expect(replyQueueName('durable', 'host:1/a')).toBe('durable-results-to-host-1-a');
    expect(replyAliveKey('durable', 'e1')).toBe('durable:reply-alive:e1');
  });

  it('sends to the shared results when nothing routes or batches', async () => {
    const t = setup();
    await t.pub.publish(result(1), 'e1');
    expect(t.sent).toEqual([{ queue: 'durable-results', name: 'result', data: result(1) }]);
  });

  it('routes a result to the live dispatching engine', async () => {
    const t = setup({ alive: ['durable:reply-alive:e1'] });
    await t.pub.publish(result(1), 'e1');
    expect(t.sent).toEqual([{ queue: 'durable-results-to-e1', name: 'result', data: result(1) }]);
  });

  it('falls back to the shared results when the routed publish fails or redis is down', async () => {
    const a = setup({ alive: ['durable:reply-alive:e1'], failQueues: ['durable-results-to-e1'] });
    await a.pub.publish(result(1), 'e1');
    expect(a.sent.map((s) => s.queue)).toEqual(['durable-results']);
    const b = setup({ redisDown: true });
    await b.pub.publish(result(1), 'e1');
    expect(b.sent.map((s) => s.queue)).toEqual(['durable-results']);
  });

  it('reads an engine liveness at most once a second', async () => {
    const t = setup({ alive: ['durable:reply-alive:e1'] });
    await t.pub.publish(result(1), 'e1');
    await t.pub.publish(result(2), 'e1');
    expect(t.exists()).toBe(1);
    t.tick(1500);
    await t.pub.publish(result(3), 'e1');
    expect(t.exists()).toBe(2);
  });

  it('batches results that finish while a batch is in flight', async () => {
    const t = setup({ batchConsumers: 1 });
    t.hold();
    const sends = Array.from({ length: 5 }, (_, i) => t.pub.publish(result(i)));
    await new Promise((r) => setImmediate(r));
    t.release();
    await Promise.all(sends);
    expect(t.sent.length).toBeLessThan(5);
    expect(t.sent.every((s) => s.queue === 'durable-results-batch' && s.name === 'results')).toBe(
      true,
    );
    expect(t.sent.flatMap((s) => (s.data as { results: unknown[] }).results)).toHaveLength(5);
  });

  it('caps a batch and sends a failed batch one result per job', async () => {
    const t = setup({ batchConsumers: 1 });
    t.hold();
    const sends = Array.from({ length: RESULT_BATCH_MAX + 10 }, (_, i) => t.pub.publish(result(i)));
    await new Promise((r) => setImmediate(r));
    t.release();
    await Promise.all(sends);
    for (const s of t.sent) {
      expect((s.data as { results: unknown[] }).results.length).toBeLessThanOrEqual(RESULT_BATCH_MAX);
    }
    const f = setup({ batchConsumers: 1, failQueues: ['durable-results-batch'] });
    await Promise.all([f.pub.publish(result(1)), f.pub.publish(result(2))]);
    expect(f.sent.map((s) => [s.queue, s.name])).toEqual([
      ['durable-results', 'result'],
      ['durable-results', 'result'],
    ]);
  });
});
