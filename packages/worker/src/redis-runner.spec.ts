import type { RemoteTask, WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { type RunnerDeps, runRedisWorker } from './redis-runner';
import { DurableWorkerRuntime } from './runner-core';

// A minimal fake bullmq surface: a Worker that captures its processor + a Queue that records `add`s,
// so we can drive a job through the runner and assert it lands on the right queue — no Redis.
function makeFakeDeps() {
  const added: Array<{ queue: string; name: string; data: unknown }> = [];
  let processor: ((job: { data: unknown }) => Promise<unknown>) | undefined;
  let workerQueueName: string | undefined;
  let workerOpts: Record<string, unknown> | undefined;

  const deps: RunnerDeps = {
    Worker: class {
      constructor(
        name: string,
        proc: (job: { data: unknown }) => Promise<unknown>,
        opts: Record<string, unknown>,
      ) {
        workerQueueName = name;
        workerOpts = opts;
        processor = proc;
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
  };

  return {
    deps,
    added,
    run: (job: { data: unknown }) => processor?.(job),
    get workerQueueName() {
      return workerQueueName;
    },
    get workerOpts() {
      return workerOpts;
    },
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
  it('consumes the group tasks queue with a generous lockDuration', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    await runRedisWorker({ runtime, group: 'pipeline', connection: {}, deps: fake.deps });
    expect(fake.workerQueueName).toBe('durable-tasks-pipeline');
    expect(fake.workerOpts?.lockDuration).toBeGreaterThanOrEqual(60_000);
  });

  it('routes a workflow job through handleTask and publishes the decision on <prefix>-decisions', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('wf', async () => ({ done: true }));
    await runRedisWorker({ runtime, group: 'wf', connection: {}, deps: fake.deps });

    await fake.run({ data: workflowTask() });

    const decision = fake.added.find((a) => a.queue === 'durable-decisions');
    expect(decision).toBeDefined();
    expect((decision?.data as { status: string }).status).toBe('completed');
  });

  it('routes a step job through handleTask and publishes the result on <prefix>-results', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerStep<number, number>('charge', (n) => n + 1);
    await runRedisWorker({ runtime, group: 'steps', connection: {}, deps: fake.deps });

    await fake.run({ data: remoteTask() });

    const result = fake.added.find((a) => a.queue === 'durable-results');
    expect(result).toBeDefined();
    expect((result?.data as { output: number }).output).toBe(8);
  });

  it('honours a custom prefix for both the consumed and published queues', async () => {
    const fake = makeFakeDeps();
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('wf', async () => 1);
    await runRedisWorker({ runtime, group: 'g', connection: {}, prefix: 'app', deps: fake.deps });
    expect(fake.workerQueueName).toBe('app-tasks-g');

    await fake.run({ data: workflowTask() });
    expect(fake.added.some((a) => a.queue === 'app-decisions')).toBe(true);
  });
});
