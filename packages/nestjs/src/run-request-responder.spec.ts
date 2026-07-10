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
  RunWaiting,
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
    waitingFor: vi.fn(async (): Promise<Record<string, RunWaiting>> => ({})),
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
    redispatchPending: vi.fn(
      async (): Promise<(RunResult & { redispatched: number }) | null> => null,
    ),
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

  it('waitingFor is bulk — ONE gateway.waitingFor call for the whole id list, not one per id', async () => {
    const gw = fakeGateway({
      waitingFor: vi.fn(
        async (): Promise<Record<string, RunWaiting>> => ({
          r1: { on: 'breakpoint', name: 'breakpoint' },
          r2: { on: 'signal', name: 'approve' },
        }),
      ),
      getRunDetail: vi.fn(
        async (id: string): Promise<RunDetail | null> => ({
          run: fakeRun(id, 'acme'),
          timeline: [],
          children: [],
        }),
      ),
    });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({
      requestId: 'q10',
      tenant: 'acme',
      body: { kind: 'waitingFor', runIds: ['r1', 'r2'] },
    });
    expect(gw.waitingFor).toHaveBeenCalledTimes(1);
    expect(gw.waitingFor).toHaveBeenCalledWith(['r1', 'r2']);
    expect(tx.replies[0]).toMatchObject({
      requestId: 'q10',
      result: {
        ok: true,
        data: {
          r1: { on: 'breakpoint', name: 'breakpoint' },
          r2: { on: 'signal', name: 'approve' },
        },
      },
    });
  });

  it('waitingFor drops entries for runs belonging to another tenant', async () => {
    const gw = fakeGateway({
      waitingFor: vi.fn(
        async (): Promise<Record<string, RunWaiting>> => ({
          mine: { on: 'breakpoint', name: 'breakpoint' },
          theirs: { on: 'signal', name: 'approve' },
        }),
      ),
      getRunDetail: vi.fn(
        async (id: string): Promise<RunDetail | null> => ({
          run: fakeRun(id, id === 'theirs' ? 'beta' : 'acme'),
          timeline: [],
          children: [],
        }),
      ),
    });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({
      requestId: 'q11',
      tenant: 'acme',
      body: { kind: 'waitingFor', runIds: ['mine', 'theirs'] },
    });
    expect(tx.replies[0]).toMatchObject({
      requestId: 'q11',
      result: { ok: true, data: { mine: { on: 'breakpoint', name: 'breakpoint' } } },
    });
    const data = (tx.replies[0]?.result as { ok: true; data: Record<string, RunWaiting> }).data;
    expect(Object.keys(data)).toEqual(['mine']);
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

  it('dispatches redispatch to the gateway', async () => {
    const gw = fakeGateway();
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({
      requestId: 'q8',
      tenant: 'acme',
      body: { kind: 'redispatch', runId: 'r1' },
    });
    expect(gw.redispatchPending).toHaveBeenCalledWith('r1');
    expect(tx.replies[0]).toMatchObject({ requestId: 'q8', result: { ok: true } });
  });

  it('denies a cross-tenant redispatch WITHOUT calling engine redispatchPending', async () => {
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
      requestId: 'q9',
      tenant: 'acme',
      body: { kind: 'redispatch', runId: 'r1' },
    });
    expect(gw.redispatchPending).not.toHaveBeenCalled();
    expect(tx.replies[0]?.result).toMatchObject({ ok: false, error: { code: 'cross-tenant' } });
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
