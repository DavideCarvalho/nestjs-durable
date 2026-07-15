import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guard contract: a NAMESPACED BullMQ transport must REFUSE to enqueue a `@tenant`-suffixed routing
 * token instead of parking it under `durable-<ns>-tasks-<name>@<tenant>` — a queue no worker
 * anywhere subscribes (tenant workers follow the operator convention: `<name>@<tenant>` under the
 * BARE prefix). The loud throw is what lets a TransportPool fail over to a bare-prefix pool member,
 * and (via the engine's child-start failure delivery) what surfaces the misroute on the run instead
 * of a silent suspended-forever parent. Exercised OFFLINE with bullmq/ioredis mocked, exactly like
 * bullmq-namespace.spec.ts.
 */

const captured = vi.hoisted(() => ({ queueNames: [] as string[] }));

vi.mock('bullmq', () => ({
  Queue: vi.fn((name: string) => {
    captured.queueNames.push(name);
    return {
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getJobCounts: vi.fn().mockResolvedValue({}),
    };
  }),
  Worker: vi.fn(() => ({
    concurrency: 1,
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
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

const baseTask = {
  runId: 'r1',
  seq: 0,
  name: 'processing',
  stepId: 'r1:0',
  input: {},
  transport: 'default',
} as const;

beforeEach(() => {
  captured.queueNames.length = 0;
});

describe('namespaced transport refuses tenant-suffixed routing tokens', () => {
  it('dispatch() of a `@tenant` token throws (instead of enqueueing into a dead scoped queue)', async () => {
    const transport = new BullMQTransport({ connection: {}, namespace: 'dev-alice' });
    await expect(
      transport.dispatch({ ...baseTask, group: 'processing@dev-alice' }),
    ).rejects.toThrow(/tenant suffix.*namespaced "dev-alice"/s);
    expect(captured.queueNames).toHaveLength(0); // refused BEFORE any queue was constructed
  });

  it('dispatchWorkflowTask() of a `@tenant` token throws the same way', async () => {
    const transport = new BullMQTransport({ connection: {}, namespace: 'dev-alice' });
    await expect(
      transport.dispatchWorkflowTask({
        taskId: 't1',
        runId: 'r1',
        workflow: 'processing',
        workflowVersion: '1',
        input: {},
        history: [],
        group: 'processing@dev-alice',
        attempt: 1,
      }),
    ).rejects.toThrow(/tenant suffix/);
  });

  it('a bare token on a namespaced transport still dispatches (scoped keyspace, self-consistent)', async () => {
    const transport = new BullMQTransport({ connection: {}, namespace: 'dev-alice' });
    await transport.dispatch({ ...baseTask, group: 'processing' });
    expect(captured.queueNames).toContain('durable-dev-alice-tasks-processing');
  });

  it('an UN-namespaced (operator) transport keeps accepting `@tenant` tokens — dev/prod unchanged', async () => {
    const transport = new BullMQTransport({ connection: {} });
    await transport.dispatch({ ...baseTask, group: 'processing@dev-alice' });
    expect(captured.queueNames).toContain('durable-tasks-processing@dev-alice');
  });

  it('the `default` namespace stays byte-identical to the un-namespaced scheme (tokens accepted)', async () => {
    const transport = new BullMQTransport({ connection: {}, namespace: 'default' });
    await transport.dispatch({ ...baseTask, group: 'processing@dev-alice' });
    expect(captured.queueNames).toContain('durable-tasks-processing@dev-alice');
  });
});
