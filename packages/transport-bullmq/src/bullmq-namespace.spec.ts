import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Namespace → name-derivation contract for the BullMQ transport, exercised OFFLINE: `bullmq` and
 * `ioredis` are mocked so constructing the transport and driving every dispatch/consume/publish path
 * records the exact queue / stream / channel / key names an engine and its workers would land on —
 * without a live Redis. The cross-SDK rule under test:
 *
 *   effectivePrefix = (namespace set && namespace !== 'default') ? `${prefix}-${namespace}` : prefix
 *
 * so an unset or `'default'` namespace must stay BYTE-IDENTICAL to the un-namespaced scheme.
 */

const captured = vi.hoisted(() => ({
  queueNames: [] as string[],
  workerNames: [] as string[],
  setKeys: [] as string[],
  publishChannels: [] as string[],
  scanMatches: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn((name: string) => {
    captured.queueNames.push(name);
    return {
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getJobCounts: vi.fn().mockResolvedValue({}),
    };
  }),
  Worker: vi.fn((name: string) => {
    captured.workerNames.push(name);
    return { concurrency: 1, close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => ({
    publish: vi.fn((channel: string) => {
      captured.publishChannels.push(channel);
      return Promise.resolve(1);
    }),
    set: vi.fn((key: string) => {
      captured.setKeys.push(key);
      return Promise.resolve('OK');
    }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    scan: vi.fn((_cursor: string, _matchKw: string, pattern: string) => {
      captured.scanMatches.push(pattern);
      return Promise.resolve(['0', []]);
    }),
    disconnect: vi.fn(),
    duplicate: vi.fn(),
  })),
}));

// Import AFTER the mocks are registered so the transport binds to the mocked bullmq/ioredis.
const { BullMQTransport } = await import('./bullmq-transport');
type TransportOptions = ConstructorParameters<typeof BullMQTransport>[0];

const connection = { host: '127.0.0.1', port: 6379 };

/** Drive every name-building path on a transport and return the names it derived (offline). */
async function deriveNames(options: Omit<TransportOptions, 'connection'>) {
  const transport = new BullMQTransport({ connection, ...options });
  await transport.dispatch({
    runId: 'r1',
    seq: 0,
    name: 'payments.charge',
    stepId: 'r1:0',
    group: 'payments',
    input: {},
    attempt: 1,
  });
  await transport.dispatchWorkflowTask({
    taskId: 't1',
    runId: 'r1',
    workflow: 'checkout',
    workflowVersion: '1',
    group: 'workflows',
    input: {},
    history: [],
    attempt: 1,
  });
  await transport.dispatchStepEvent({
    runId: 'r1',
    seq: 0,
    name: 'local.step',
    phase: 'running',
    startedAt: Date.now(),
  });
  transport.onResult(async () => {});
  transport.onDecision(async () => {});
  transport.onStepEvent(async () => {});
  await transport.publishControl({ kind: 'cancel', runId: 'r1', from: 'engine' });
  await transport.heartbeat({ runId: 'r1', seq: 0, stepId: 'r1:0', group: 'payments' });
  if (options.group) transport.handle('payments.charge', async () => ({})); // worker tasks queue + heartbeat key
  await transport.listWorkerGroups();
  await transport.close();
  return captured;
}

describe('BullMQTransport namespace → name partitioning', () => {
  beforeEach(() => {
    captured.queueNames.length = 0;
    captured.workerNames.length = 0;
    captured.setKeys.length = 0;
    captured.publishChannels.length = 0;
    captured.scanMatches.length = 0;
  });

  it('no namespace → names are byte-identical to the un-namespaced (`durable`) scheme', async () => {
    const names = await deriveNames({ group: 'payments' });

    expect(names.queueNames).toContain('durable-tasks-payments'); // tasksName (dispatch + worker)
    expect(names.queueNames).toContain('durable-tasks-workflows'); // tasksName (workflow dispatch)
    expect(names.queueNames).toContain('durable-step-events'); // stepEventsName (dispatch)
    expect(names.workerNames).toContain('durable-results'); // resultsName
    expect(names.workerNames).toContain('durable-decisions'); // decisionsName
    expect(names.workerNames).toContain('durable-step-events'); // stepEventsName (consume)
    expect(names.publishChannels).toContain('durable-control'); // controlChannel
    expect(names.publishChannels).toContain('durable-heartbeat'); // heartbeatChannel
    expect(names.setKeys.some((k) => k.startsWith('durable-worker-heartbeat:payments:'))).toBe(
      true,
    );
    expect(names.scanMatches).toContain('durable-worker-heartbeat:*'); // listWorkerGroups
  });

  it('"default" namespace → identical to no namespace (production must not change)', async () => {
    const names = await deriveNames({ group: 'payments', namespace: 'default' });

    expect(names.queueNames).toContain('durable-tasks-payments');
    expect(names.workerNames).toContain('durable-results');
    expect(names.publishChannels).toContain('durable-control');
    expect(names.setKeys.some((k) => k.startsWith('durable-worker-heartbeat:payments:'))).toBe(
      true,
    );
    // No segment leaked in for the reserved "default" namespace.
    expect(names.queueNames.some((n) => n.includes('durable-default'))).toBe(false);
  });

  it('a non-default namespace segments EVERY name builder', async () => {
    const names = await deriveNames({ group: 'payments', namespace: 'dev-alice' });

    expect(names.queueNames).toContain('durable-dev-alice-tasks-payments');
    expect(names.queueNames).toContain('durable-dev-alice-tasks-workflows');
    expect(names.queueNames).toContain('durable-dev-alice-step-events');
    expect(names.workerNames).toContain('durable-dev-alice-results');
    expect(names.workerNames).toContain('durable-dev-alice-decisions');
    expect(names.workerNames).toContain('durable-dev-alice-step-events');
    expect(names.publishChannels).toContain('durable-dev-alice-control');
    expect(names.publishChannels).toContain('durable-dev-alice-heartbeat');
    expect(
      names.setKeys.some((k) => k.startsWith('durable-dev-alice-worker-heartbeat:payments:')),
    ).toBe(true);
    expect(names.scanMatches).toContain('durable-dev-alice-worker-heartbeat:*');
    // A default-namespace engine's names never collide with these.
    expect(names.queueNames).not.toContain('durable-tasks-payments');
  });

  it('honours a custom prefix alongside the namespace', async () => {
    const names = await deriveNames({ group: 'payments', prefix: 'flip', namespace: 'dev-bob' });
    expect(names.queueNames).toContain('flip-dev-bob-tasks-payments');
    expect(names.publishChannels).toContain('flip-dev-bob-control');
  });
});

describe('BullMQTransport.useNamespace precedence', () => {
  beforeEach(() => {
    captured.queueNames.length = 0;
  });

  it('useNamespace sets the namespace when none was given at construction', async () => {
    const transport = new BullMQTransport({ connection, group: 'payments' });
    transport.useNamespace('dev-carol');
    await transport.dispatch({
      runId: 'r1',
      seq: 0,
      name: 'n',
      stepId: 'r1:0',
      group: 'payments',
      input: {},
      attempt: 1,
    });
    await transport.close();
    expect(captured.queueNames).toContain('durable-dev-carol-tasks-payments');
  });

  it('an EXPLICIT constructor namespace wins over a later useNamespace', async () => {
    const transport = new BullMQTransport({
      connection,
      group: 'payments',
      namespace: 'dev-explicit',
    });
    transport.useNamespace('dev-override'); // ignored — constructor was explicit
    await transport.dispatch({
      runId: 'r1',
      seq: 0,
      name: 'n',
      stepId: 'r1:0',
      group: 'payments',
      input: {},
      attempt: 1,
    });
    await transport.close();
    expect(captured.queueNames).toContain('durable-dev-explicit-tasks-payments');
    expect(captured.queueNames).not.toContain('durable-dev-override-tasks-payments');
  });

  it('an explicit "default" constructor namespace still wins (useNamespace cannot override it)', async () => {
    const transport = new BullMQTransport({ connection, group: 'payments', namespace: 'default' });
    transport.useNamespace('dev-override');
    await transport.dispatch({
      runId: 'r1',
      seq: 0,
      name: 'n',
      stepId: 'r1:0',
      group: 'payments',
      input: {},
      attempt: 1,
    });
    await transport.close();
    expect(captured.queueNames).toContain('durable-tasks-payments'); // stayed un-segmented
    expect(captured.queueNames).not.toContain('durable-dev-override-tasks-payments');
  });

  it('useNamespace is idempotent (re-applying the same namespace is a no-op)', async () => {
    const transport = new BullMQTransport({ connection, group: 'payments' });
    transport.useNamespace('dev-dan');
    transport.useNamespace('dev-dan');
    await transport.dispatch({
      runId: 'r1',
      seq: 0,
      name: 'n',
      stepId: 'r1:0',
      group: 'payments',
      input: {},
      attempt: 1,
    });
    await transport.close();
    expect(captured.queueNames).toContain('durable-dev-dan-tasks-payments');
  });
});
