import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Terminal task-failure bridge, exercised OFFLINE (`bullmq`/`ioredis` mocked). A task job that reaches
 * a TERMINAL `failed` state is always an INFRASTRUCTURE failure — a worker crash, stalled-count
 * exhaustion, or an unexpected throw inside `runTask` (e.g. a Redis publish error) — never a handler
 * business error (those succeed the job with a failed StepResult). Without a bridge the engine's
 * `pending` checkpoint never settles and the run hangs forever. These tests assert the transport turns
 * that terminal failure into a synthetic failed StepResult published to the results queue, so the
 * engine's normal `onResult` path settles the checkpoint `failed` → durable retry re-dispatches.
 */

const captured = vi.hoisted(() => ({
  adds: [] as { queue: string; name: string; data: unknown; opts: unknown }[],
  failedListeners: [] as { queue: string; handler: (job: unknown, error: Error) => void }[],
  processors: [] as { queue: string; processor: (job: { data: unknown }) => Promise<void> }[],
  // When set, the NEXT `add` to the results queue rejects once (simulates a Redis publish blip).
  failNextResultsAdd: false,
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn((queueName: string) => ({
    add: vi.fn((name: string, data: unknown, opts: unknown) => {
      captured.adds.push({ queue: queueName, name, data, opts });
      if (queueName.endsWith('-results') && captured.failNextResultsAdd) {
        captured.failNextResultsAdd = false;
        return Promise.reject(new Error('redis publish blip'));
      }
      return Promise.resolve(undefined);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn().mockResolvedValue({}),
  })),
  Worker: vi.fn((queueName: string, processor: (job: { data: unknown }) => Promise<void>) => {
    captured.processors.push({ queue: queueName, processor });
    return {
      concurrency: 1,
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: (job: unknown, error: Error) => void) => {
        if (event === 'failed') captured.failedListeners.push({ queue: queueName, handler });
      }),
    };
  }),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    scan: vi.fn().mockResolvedValue(['0', []]),
    disconnect: vi.fn(),
    duplicate: vi.fn(),
  })),
}));

// Import AFTER the mocks are registered so the transport binds to the mocked bullmq/ioredis.
const { BullMQTransport } = await import('./bullmq-transport');
const connection = { host: '127.0.0.1', port: 6379 };

const remoteTask = (over: { runId: string; seq: number; name: string }) => ({
  runId: over.runId,
  seq: over.seq,
  stepId: `${over.runId}:${over.seq}`,
  name: over.name,
  group: over.name,
  input: {},
  attempt: 1,
});

const resultAdds = () => captured.adds.filter((a) => a.queue.endsWith('-results'));

describe('BullMQTransport — terminal task-failure bridge', () => {
  beforeEach(() => {
    captured.adds.length = 0;
    captured.failedListeners.length = 0;
    captured.processors.length = 0;
    captured.failNextResultsAdd = false;
  });

  it("dispatch retains a failed task job's payload so the bridge can read it (removeOnFail: age)", async () => {
    const transport = new BullMQTransport({ connection });
    await transport.dispatch(remoteTask({ runId: 'r1', seq: 0, name: 'payments.charge-card' }));
    const taskAdd = captured.adds.find((a) => a.queue === 'durable-tasks-payments.charge-card');
    expect(taskAdd?.opts).toMatchObject({ removeOnFail: { age: expect.any(Number) } });
    await transport.close();
  });

  it('publishes a synthetic failed StepResult when a task job fails at the infra level (crash/stall)', async () => {
    const transport = new BullMQTransport({ connection });
    transport.handle('payments.charge-card', async () => ({}));

    const bridge = captured.failedListeners.find(
      (l) => l.queue === 'durable-tasks-payments.charge-card',
    );
    expect(bridge).toBeDefined();

    // Simulate BullMQ terminally failing the job (a peer's stalled-check exhausted maxStalledCount),
    // handing the listener the failed job WITH its original RemoteTask payload.
    bridge?.handler(
      {
        data: remoteTask({ runId: 'run-1', seq: 3, name: 'payments.charge-card' }),
        failedReason: 'job stalled more than allowable limit',
      },
      new Error('job stalled more than allowable limit'),
    );
    await Promise.resolve();
    await Promise.resolve();

    const published = resultAdds();
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      runId: 'run-1',
      seq: 3,
      stepId: 'run-1:3',
      status: 'failed',
      error: { message: expect.stringContaining('job stalled'), retryable: true },
    });
    // StepResult carries no `name` field — the engine correlates by runId/seq/stepId only.
    expect(published[0]?.data).not.toHaveProperty('name');

    await transport.close();
  });

  it("no-ops safely when the failed job's payload was already GC'd (undefined job)", async () => {
    const transport = new BullMQTransport({ connection });
    transport.handle('a', async () => ({}));
    const bridge = captured.failedListeners.find((l) => l.queue === 'durable-tasks-a');

    bridge?.handler(undefined, new Error('job stalled more than allowable limit'));
    await Promise.resolve();

    expect(resultAdds()).toHaveLength(0);
    await transport.close();
  });

  it('in-process net: publishes a synthetic failed result when publishing the real result throws', async () => {
    const transport = new BullMQTransport({ connection });
    transport.handle('svc.step', async () => ({ ok: true }));
    const proc = captured.processors.find((p) => p.queue === 'durable-tasks-svc.step');
    expect(proc).toBeDefined();

    // The handler completes fine, but the results-queue publish blips → runTask's catch synthesizes
    // a retryable failed result rather than letting the checkpoint hang on `pending`.
    captured.failNextResultsAdd = true;
    await proc?.processor({ data: remoteTask({ runId: 'r9', seq: 1, name: 'svc.step' }) });

    const published = resultAdds();
    expect(published).toHaveLength(2); // [0] real completed result (rejected), [1] synthetic net
    expect(published[1]?.data).toMatchObject({
      runId: 'r9',
      seq: 1,
      stepId: 'r9:1',
      status: 'failed',
      error: { retryable: true },
    });

    await transport.close();
  });
});
