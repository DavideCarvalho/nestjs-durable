import type { WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerDeps, StartRunDeps } from './redis-runner';
import { runRedisWorker, startRun } from './redis-runner';
import { DurableWorkerRuntime } from './runner-core';

/**
 * P4C.2 — a worker's `partition` is DISTINCT from its transport prefix: only the per-name queue
 * TOKEN it registers/heartbeats under gets partition-suffixed (`tenantGroup(sanitizeQueueToken(
 * name), partition)`), so an operator control plane's `listWorkerGroups()` sees
 * `<workflow>@<partition>` for a real partition, and the bare `<workflow>` for
 * `undefined`/`'default'` — production byte-identical. `tenant` is a deprecated alias for
 * `partition`; `group` no longer affects routing at all (subscription is derived from the
 * runtime's registered names).
 *
 * These tests reuse the fake-bullmq/fake-ioredis pattern from `redis-runner.spec.ts` and the
 * `startRun` wire-payload pattern from `start-run-client.spec.ts` rather than inventing new fakes.
 */

interface CapturedSet {
  key: string;
  value: string;
}

function makeFakeDeps(): {
  deps: RunnerDeps;
  workerQueueNames: () => string[];
  publishedHeartbeats: () => Array<{ channel: string; payload: string }>;
  sets: () => CapturedSet[];
  run: (queueName: string, job: { data: unknown }) => Promise<unknown> | undefined;
} {
  const published: Array<{ channel: string; payload: string }> = [];
  const sets: CapturedSet[] = [];
  const workers: Array<{
    name: string;
    processor: (job: { data: unknown }) => Promise<unknown>;
  }> = [];

  // Mirrors `redis-runner.spec.ts`'s FakeRedis, plus recording `set()` calls so a test can assert
  // the exact worker-heartbeat KEY (which is where the partition-suffixed token must show up).
  class FakeRedis {
    duplicate() {
      return { subscribe: async () => {}, on: () => {}, disconnect: () => {} };
    }
    async set(key: string, value: string) {
      sets.push({ key, value });
    }
    async publish(channel: string, payload: string) {
      published.push({ channel, payload });
    }
    async subscribe() {}
    on() {}
    disconnect() {}
  }

  const deps: RunnerDeps = {
    Worker: class {
      constructor(name: string, proc: (job: { data: unknown }) => Promise<unknown>) {
        workers.push({ name, processor: proc });
      }
      async close() {}
    },
    Queue: class {
      constructor(private readonly name: string) {}
      async add() {}
      async close() {}
    },
    Redis: FakeRedis as unknown as RunnerDeps['Redis'],
  };

  return {
    deps,
    workerQueueNames: () => workers.map((w) => w.name),
    publishedHeartbeats: () => published.filter((p) => p.channel === 'durable-heartbeat'),
    sets: () => sets,
    run: (queueName: string, job: { data: unknown }) =>
      workers.find((w) => w.name === queueName)?.processor(job),
  };
}

function workflowTask(over: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    taskId: 't0',
    runId: 'run-1',
    workflow: 'processing',
    workflowVersion: '1',
    input: null,
    history: [],
    pendingSignals: [],
    group: 'processing',
    attempt: 1,
    ...over,
  };
}

describe('runRedisWorker — partition-suffixed per-name queue', () => {
  it('consumes the partition-suffixed tasks queue when a real partition is configured', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => 1);
    await runRedisWorker({ runtime, partition: 'davi-local', connection: {}, deps: fake.deps });
    expect(fake.workerQueueNames()).toEqual(['durable-tasks-processing@davi-local']);
  });

  it('`tenant` is a deprecated alias for `partition` (routes identically)', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => 1);
    await runRedisWorker({ runtime, tenant: 'davi-local', connection: {}, deps: fake.deps });
    expect(fake.workerQueueNames()).toEqual(['durable-tasks-processing@davi-local']);
  });

  it('heartbeats the partition-suffixed token key when a real partition is configured', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => 1);
    await runRedisWorker({
      runtime,
      partition: 'davi-local',
      connection: {},
      instanceId: 'ts-test-1',
      deps: fake.deps,
    });
    const beat = fake.sets().find((s) => s.key.startsWith('durable-worker-heartbeat:'));
    expect(beat?.key).toBe('durable-worker-heartbeat:processing@davi-local:ts-test-1');
  });

  it('registers the BARE token when no partition is configured (production byte-identical)', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => 1);
    await runRedisWorker({ runtime, connection: {}, deps: fake.deps });
    expect(fake.workerQueueNames()).toEqual(['durable-tasks-processing']);
  });

  it('registers the BARE token when partition is "default" (byte-identical to unset)', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => 1);
    await runRedisWorker({ runtime, partition: 'default', connection: {}, deps: fake.deps });
    expect(fake.workerQueueNames()).toEqual(['durable-tasks-processing']);
  });

  it('registers the BARE token for an empty-string partition', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => 1);
    await runRedisWorker({ runtime, partition: '', connection: {}, deps: fake.deps });
    expect(fake.workerQueueNames()).toEqual(['durable-tasks-processing']);
  });
});

describe("runRedisWorker — run-scoped heartbeat carries the dispatched task's own routing token", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes the run-scoped beat with the (already partition-suffixed) task group', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => ({ done: true }));
    await runRedisWorker({ runtime, partition: 'davi-local', connection: {}, deps: fake.deps });

    // The dispatching engine (Task 2) already stamps the FINAL routing token onto the task itself —
    // the runner threads that verbatim into the run-scoped beat, not a value it recomputes.
    await fake.run('durable-tasks-processing@davi-local', {
      data: workflowTask({ group: 'processing@davi-local' }),
    });

    const beats = fake.publishedHeartbeats();
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(beats[0]?.payload ?? '{}')).toEqual({
      runId: 'run-1',
      seq: 0,
      group: 'processing@davi-local',
    });
  });
});

describe('startRun — tenant + idempotent runId dispatch', () => {
  function makeFakeStartRunDeps(): {
    deps: StartRunDeps;
    captures: Array<{ queue: string; jobName: string; data: unknown }>;
  } {
    const captures: Array<{ queue: string; jobName: string; data: unknown }> = [];
    const deps: StartRunDeps = {
      Queue: class {
        constructor(private readonly name: string) {}
        async add(jobName: string, data: unknown): Promise<void> {
          captures.push({ queue: this.name, jobName, data });
        }
        async close(): Promise<void> {}
      },
    };
    return { deps, captures };
  }

  it('dispatches a StartRunMessage carrying tenant + the caller-supplied runId verbatim', async () => {
    const { deps, captures } = makeFakeStartRunDeps();
    await startRun(
      {},
      {
        tenant: 'davi-local',
        workflow: 'processing',
        input: { qty: 1 },
        runId: 'caller-run-id-1',
        deps,
      },
    );
    expect(captures[0]?.data).toEqual({
      tenant: 'davi-local',
      workflow: 'processing',
      input: { qty: 1 },
      runId: 'caller-run-id-1',
    });
  });

  it('redelivering the same call dispatches the identical runId (no per-delivery uuid minted)', async () => {
    const { deps, captures } = makeFakeStartRunDeps();
    const opts = {
      tenant: 'davi-local',
      workflow: 'processing',
      input: null,
      runId: 'caller-run-id-1',
      deps,
    };
    await startRun({}, opts);
    await startRun({}, opts); // simulates a retryable consumer redelivering the same message
    expect(captures[0]?.data).toMatchObject({ runId: 'caller-run-id-1' });
    expect(captures[1]?.data).toMatchObject({ runId: 'caller-run-id-1' });
  });
});
