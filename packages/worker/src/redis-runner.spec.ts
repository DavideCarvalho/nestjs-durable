import type { RemoteTask, WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunnerDeps, runRedisWorker } from './redis-runner';
import { DurableWorkerRuntime } from './runner-core';

// A minimal fake bullmq surface: EVERY `new Worker(...)` call is captured (the runner now starts
// one per registered name), plus a Queue that records `add`s — so a test can drive a job through
// the runner (routed to the fake Worker subscribed on the matching queue name) and assert what
// landed where — no Redis.
function makeFakeDeps(opts: { withRedis?: boolean } = {}) {
  const added: Array<{ queue: string; name: string; data: unknown }> = [];
  const published: Array<{ channel: string; payload: string }> = [];
  const workers: Array<{
    name: string;
    opts: Record<string, unknown>;
    processor: (job: { data: unknown }) => Promise<unknown>;
  }> = [];

  // A fake ioredis client recording `publish` (run/step heartbeats) — `set`/`subscribe`/`duplicate`
  // are stubs so the runner's best-effort control + worker-TTL setup runs without a real broker.
  class FakeRedis {
    duplicate() {
      return { subscribe: async () => {}, on: () => {}, disconnect: () => {} };
    }
    async set() {}
    async publish(channel: string, payload: string) {
      published.push({ channel, payload });
    }
    async subscribe() {}
    on() {}
    disconnect() {}
  }

  const deps: RunnerDeps = {
    Worker: class {
      constructor(
        name: string,
        proc: (job: { data: unknown }) => Promise<unknown>,
        wopts: Record<string, unknown>,
      ) {
        workers.push({ name, opts: wopts, processor: proc });
      }
      async close() {}
    },
    Queue: class {
      constructor(private readonly name: string) {}
      async add(name: string, data: unknown) {
        added.push({ queue: this.name, name, data });
      }
      async close() {}
    },
    ...(opts.withRedis ? { Redis: FakeRedis as unknown as RunnerDeps['Redis'] } : {}),
  };

  return {
    deps,
    added,
    published,
    workers,
    /** The queue names every started fake Worker subscribed on (one per registered name). */
    get workerQueueNames(): string[] {
      return workers.map((w) => w.name);
    },
    /** Options a specific queue's Worker was constructed with. */
    workerOptsFor: (queueName: string) => workers.find((w) => w.name === queueName)?.opts,
    /** Drive `job` through the fake Worker subscribed on `queueName` — mirrors BullMQ's per-queue
     *  delivery (a job only ever reaches the Worker consuming ITS queue). */
    run: (queueName: string, job: { data: unknown }) =>
      workers.find((w) => w.name === queueName)?.processor(job),
  };
}

function workflowTask(over: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    taskId: 't0',
    runId: 'r1',
    workflow: 'wf',
    workflowVersion: '1',
    input: null,
    history: [],
    pendingSignals: [],
    group: 'wf',
    attempt: 1,
    ...over,
  };
}

function remoteTask(over: Partial<RemoteTask> = {}): RemoteTask {
  return {
    runId: 'r1',
    seq: 0,
    name: 'charge',
    stepId: 'r1:0',
    group: 'steps',
    input: 7,
    attempt: 1,
    ...over,
  };
}

describe('runRedisWorker wiring (faked bullmq, no Redis)', () => {
  it('subscribes one queue per registered name, NOT a single hand-declared group queue', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('pipeline', async () => 1);
    runtime.registerStep<number, number>('extraction:page', (n) => n);
    await runRedisWorker({ runtime, connection: {}, deps: fake.deps });
    expect(fake.workerQueueNames.sort()).toEqual([
      'durable-tasks-extraction-page', // ':' sanitized to '-' (BullMQ forbids ':')
      'durable-tasks-pipeline',
    ]);
    for (const name of fake.workerQueueNames) {
      expect(fake.workerOptsFor(name)?.lockDuration).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('suffixes every subscribed queue with `partition` when set', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('pipeline', async () => 1);
    runtime.registerStep<number, number>('extraction:page', (n) => n);
    await runRedisWorker({ runtime, connection: {}, partition: 'davi-local', deps: fake.deps });
    expect(fake.workerQueueNames.sort()).toEqual([
      'durable-tasks-extraction-page@davi-local',
      'durable-tasks-pipeline@davi-local',
    ]);
  });

  it('starts no Worker at all when nothing is registered', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    await runRedisWorker({ runtime, connection: {}, deps: fake.deps });
    expect(fake.workerQueueNames).toEqual([]);
  });

  it('routes a workflow job through handleTask and publishes the decision on <prefix>-decisions', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('wf', async () => ({ done: true }));
    await runRedisWorker({ runtime, connection: {}, deps: fake.deps });

    await fake.run('durable-tasks-wf', { data: workflowTask() });

    const decision = fake.added.find((a) => a.queue === 'durable-decisions');
    expect(decision).toBeDefined();
    expect((decision?.data as { status: string }).status).toBe('completed');
  });

  it('routes a step job through handleTask and publishes the result on <prefix>-results', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerStep<number, number>('charge', (n) => n + 1);
    await runRedisWorker({ runtime, connection: {}, deps: fake.deps });

    await fake.run('durable-tasks-charge', { data: remoteTask() });

    const result = fake.added.find((a) => a.queue === 'durable-results');
    expect(result).toBeDefined();
    expect((result?.data as { output: number }).output).toBe(8);
  });

  it('honours a custom prefix for both the consumed and published queues', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('wf', async () => 1);
    await runRedisWorker({ runtime, connection: {}, prefix: 'app', deps: fake.deps });
    expect(fake.workerQueueNames).toEqual(['app-tasks-wf']);

    await fake.run('app-tasks-wf', { data: workflowTask() });
    expect(fake.added.some((a) => a.queue === 'app-decisions')).toBe(true);
  });
});

describe('runRedisWorker — run-scoped liveness heartbeat during a workflow turn', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A workflow whose body blocks until the test releases it, so a turn is observably "in flight". */
  function gate() {
    let release!: () => void;
    const gated = new Promise<void>((r) => {
      release = r;
    });
    return { gated, release };
  }

  it('publishes a run-scoped beat ({runId, seq:0, group}, no stepId) while the turn is in flight', async () => {
    const fake = makeFakeDeps({ withRedis: true });
    const runtime = new DurableWorkerRuntime();
    const g = gate();
    runtime.registerWorkflow('wf', async () => {
      await g.gated;
      return { done: true };
    });
    await runRedisWorker({ runtime, connection: {}, deps: fake.deps });

    const turn = fake.run('durable-tasks-wf', {
      data: workflowTask({ runId: 'run-42', group: 'wf' }),
    });

    // Immediate beat while the turn is still blocked.
    const beats = () => fake.published.filter((p) => p.channel === 'durable-heartbeat');
    expect(beats().length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(beats()[0]?.payload ?? '{}')).toEqual({
      runId: 'run-42',
      seq: 0,
      group: 'wf',
    });
    expect(JSON.parse(beats()[0]?.payload ?? '{}')).not.toHaveProperty('stepId');

    // Interval beats keep coming while the turn runs.
    const before = beats().length;
    vi.advanceTimersByTime(5_000);
    expect(beats().length).toBe(before + 1);

    g.release();
    await turn;

    // After settle, no further beats (interval cleared in the finally).
    const settled = beats().length;
    vi.advanceTimersByTime(60_000);
    expect(beats().length).toBe(settled);
  });

  it('does not run-beat for a remote step task (only workflow turns beat)', async () => {
    const fake = makeFakeDeps({ withRedis: true });
    const runtime = new DurableWorkerRuntime();
    runtime.registerStep<number, number>('charge', (n) => n + 1);
    await runRedisWorker({ runtime, connection: {}, deps: fake.deps });

    await fake.run('durable-tasks-charge', { data: remoteTask() });

    expect(fake.published.filter((p) => p.channel === 'durable-heartbeat')).toHaveLength(0);
  });
});
