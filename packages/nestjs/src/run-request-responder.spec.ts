import type {
  DurableTopology,
  EngineEvent,
  GroupHealth,
  RunDetail,
  RunGateway,
  RunQuery,
  RunReply,
  RunRequest,
  RunResult,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it, vi } from 'vitest';
import { RunRequestResponder, type RunRequestTransport } from './run-request-responder';

function fakeRun(id: string, namespace: string): WorkflowRun {
  return {
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'completed',
    input: null,
    namespace,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeGateway(overrides: Partial<RunGateway> = {}): RunGateway {
  return {
    topology: vi.fn((): DurableTopology => ({ role: 'control-plane' })),
    getRunDetail: vi.fn(
      async (id: string): Promise<RunDetail | null> => ({
        run: fakeRun(id, 'acme'),
        timeline: [],
        children: [],
      }),
    ),
    listRuns: vi.fn(
      async (query: RunQuery): Promise<WorkflowRun[]> => [
        fakeRun('x', query.namespace ?? 'default'),
      ],
    ),
    workerHealth: vi.fn(
      async (): Promise<GroupHealth[]> => [
        { group: 'pipeline@acme', depth: 1, liveWorkers: [] },
        { group: 'pipeline@beta', depth: 9, liveWorkers: [] },
        { group: 'pipeline', depth: 0, liveWorkers: [] },
      ],
    ),
    cancel: vi.fn(async (): Promise<RunResult | null> => null),
    retry: vi.fn(async (): Promise<RunResult | null> => null),
    continue: vi.fn(async (): Promise<RunResult | null> => null),
    retryWithInput: vi.fn(async (): Promise<{ runId: string } | null> => ({ runId: 'n' })),
    subscribe: vi.fn((_onEvent: (event: EngineEvent) => void) => () => {}),
    ...overrides,
  };
}

function fakeTransport(): RunRequestTransport & {
  deliver: (msg: RunRequest) => Promise<void>;
  replies: RunReply[];
} {
  let onReq: ((msg: RunRequest) => Promise<void>) | undefined;
  const replies: RunReply[] = [];
  return {
    onRunRequest: (handler: (msg: RunRequest) => Promise<void>) => {
      onReq = handler;
    },
    publishRunReply: async (reply: RunReply) => {
      replies.push(reply);
    },
    deliver: async (msg: RunRequest) => {
      if (!onReq) throw new Error('no onRunRequest handler was registered');
      await onReq(msg);
    },
    replies,
  };
}

describe('RunRequestResponder', () => {
  it('answers getRunDetail scoped to the tenant', async () => {
    const gw = fakeGateway();
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'getRunDetail', runId: 'r1' },
    });
    expect(tx.replies[0]).toMatchObject({ requestId: 'q1', result: { ok: true } });
  });

  it('denies a cross-tenant getRunDetail and never calls the verb again', async () => {
    const gw = fakeGateway({
      getRunDetail: vi.fn(
        async (id: string): Promise<RunDetail | null> => ({
          run: fakeRun(id, 'beta'),
          timeline: [],
          children: [],
        }),
      ),
    });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({
      requestId: 'q2',
      tenant: 'acme',
      body: { kind: 'getRunDetail', runId: 'r1' },
    });
    expect(tx.replies[0]).toMatchObject({
      requestId: 'q2',
      result: { ok: false, error: { code: 'cross-tenant' } },
    });
  });

  it('forces listRuns namespace to the tenant', async () => {
    const gw = fakeGateway();
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({
      requestId: 'q3',
      tenant: 'acme',
      body: { kind: 'listRuns', query: { namespace: 'beta' } },
    });
    expect(gw.listRuns).toHaveBeenCalledWith({ namespace: 'acme' });
  });

  it('scopes workerHealth to the tenant own `@<tenant>` groups', async () => {
    const gw = fakeGateway();
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q7', tenant: 'acme', body: { kind: 'workerHealth' } });
    // Only `pipeline@acme` survives — `pipeline@beta` (another tenant) and the operator's bare
    // `pipeline` group are both dropped, so a tenant never sees another's queues.
    expect(tx.replies[0]).toMatchObject({
      requestId: 'q7',
      result: { ok: true, data: [{ group: 'pipeline@acme' }] },
    });
    expect((tx.replies[0]?.result as { ok: true; data: GroupHealth[] }).data).toHaveLength(1);
  });

  it('denies a cross-tenant cancel WITHOUT calling engine cancel', async () => {
    const gw = fakeGateway({
      getRunDetail: vi.fn(
        async (id: string): Promise<RunDetail | null> => ({
          run: fakeRun(id, 'beta'),
          timeline: [],
          children: [],
        }),
      ),
    });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q4', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
    expect(gw.cancel).not.toHaveBeenCalled();
    expect(tx.replies[0]?.result).toMatchObject({ ok: false, error: { code: 'cross-tenant' } });
  });

  it('passes cancel opts to the gateway', async () => {
    const gw = fakeGateway();
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({
      requestId: 'q6',
      tenant: 'acme',
      body: { kind: 'cancel', runId: 'r1', opts: { compensate: true } },
    });
    expect(gw.cancel).toHaveBeenCalledWith('r1', { compensate: true });
  });

  it('serialises a thrown verb error into an error reply', async () => {
    const gw = fakeGateway({
      getRunDetail: vi.fn(
        async (id: string): Promise<RunDetail | null> => ({
          run: fakeRun(id, 'acme'),
          timeline: [],
          children: [],
        }),
      ),
      cancel: vi.fn(async (): Promise<RunResult | null> => {
        throw new Error('already terminal');
      }),
    });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q5', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
    expect(tx.replies[0]?.result).toMatchObject({
      ok: false,
      error: { message: 'already terminal' },
    });
  });
});
