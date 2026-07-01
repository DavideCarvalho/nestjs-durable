import type { WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerDeps, StartRunDeps } from './redis-runner';
import { runRedisWorker, startRun } from './redis-runner';
import { DurableWorkerRuntime } from './runner-core';

/**
 * P4C.2 — a worker's `tenant` is DISTINCT from its transport prefix: only the worker GROUP it
 * registers/heartbeats under gets tenant-suffixed (`tenantGroup(baseGroup, tenant)`), so an
 * operator control plane's `listWorkerGroups()` sees `<workflow>@<tenant>` for a real tenant,
 * and the bare `<workflow>` for `undefined`/`'default'` — production byte-identical.
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
  workerQueueName: () => string | undefined;
  publishedHeartbeats: () => Array<{ channel: string; payload: string }>;
  sets: () => CapturedSet[];
  run: (job: { data: unknown }) => Promise<unknown> | undefined;
} {
  const published: Array<{ channel: string; payload: string }> = [];
  const sets: CapturedSet[] = [];
  let processor: ((job: { data: unknown }) => Promise<unknown>) | undefined;
  let workerQueueName: string | undefined;

  // Mirrors `redis-runner.spec.ts`'s FakeRedis, plus recording `set()` calls so a test can assert
  // the exact worker-heartbeat KEY (which is where the tenant-suffixed group must show up).
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
        workerQueueName = name;
        processor = proc;
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
    workerQueueName: () => workerQueueName,
    publishedHeartbeats: () => published.filter((p) => p.channel === 'durable-heartbeat'),
    sets: () => sets,
    run: (job: { data: unknown }) => processor?.(job),
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

describe('runRedisWorker — tenant-suffixed worker group', () => {
  it('consumes the tenant-suffixed tasks queue when a real tenant is configured', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    await runRedisWorker({
      runtime,
      group: 'processing',
      tenant: 'davi-local',
      connection: {},
      deps: fake.deps,
    });
    expect(fake.workerQueueName()).toBe('durable-tasks-processing@davi-local');
  });

  it('heartbeats the tenant-suffixed group key when a real tenant is configured', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    await runRedisWorker({
      runtime,
      group: 'processing',
      tenant: 'davi-local',
      connection: {},
      instanceId: 'ts-test-1',
      deps: fake.deps,
    });
    const beat = fake.sets().find((s) => s.key.startsWith('durable-worker-heartbeat:'));
    expect(beat?.key).toBe('durable-worker-heartbeat:processing@davi-local:ts-test-1');
  });

  it('registers the BARE group when no tenant is configured (production byte-identical)', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    await runRedisWorker({ runtime, group: 'processing', connection: {}, deps: fake.deps });
    expect(fake.workerQueueName()).toBe('durable-tasks-processing');
  });

  it('registers the BARE group when tenant is "default" (byte-identical to unset)', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    await runRedisWorker({
      runtime,
      group: 'processing',
      tenant: 'default',
      connection: {},
      deps: fake.deps,
    });
    expect(fake.workerQueueName()).toBe('durable-tasks-processing');
  });

  it('registers the BARE group for an empty-string tenant', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    await runRedisWorker({
      runtime,
      group: 'processing',
      tenant: '',
      connection: {},
      deps: fake.deps,
    });
    expect(fake.workerQueueName()).toBe('durable-tasks-processing');
  });
});

describe('runRedisWorker — run-scoped heartbeat carries the tenant-suffixed group', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes the run-scoped beat with the tenant-suffixed group', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('processing', async () => ({ done: true }));
    await runRedisWorker({
      runtime,
      group: 'processing',
      tenant: 'davi-local',
      connection: {},
      deps: fake.deps,
    });

    await fake.run({ data: workflowTask() });

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
