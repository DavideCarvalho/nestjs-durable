import type {
  EngineEvent,
  RunDetail,
  RunGateway,
  RunQuery,
  RunReply,
  RunRequest,
  RunResult,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it, vi } from 'vitest';
import { type RunRequestTransport, RunRequestResponder } from './run-request-responder';

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
    getRunDetail: vi.fn(
      async (id: string): Promise<RunDetail | null> => ({
        run: fakeRun(id, 'acme'),
        timeline: [],
        children: [],
      }),
    ),
    listRuns: vi.fn(
      async (query: RunQuery): Promise<WorkflowRun[]> => [fakeRun('x', query.namespace ?? 'default')],
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
    await tx.deliver({ requestId: 'q1', tenant: 'acme', body: { kind: 'getRunDetail', runId: 'r1' } });
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
    await tx.deliver({ requestId: 'q2', tenant: 'acme', body: { kind: 'getRunDetail', runId: 'r1' } });
    expect(tx.replies[0]).toMatchObject({
      requestId: 'q2',
      result: { ok: false, error: { code: 'cross-tenant' } },
    });
  });

  it('forces listRuns namespace to the tenant', async () => {
    const gw = fakeGateway();
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();
    await tx.deliver({ requestId: 'q3', tenant: 'acme', body: { kind: 'listRuns', query: { namespace: 'beta' } } });
    expect(gw.listRuns).toHaveBeenCalledWith({ namespace: 'acme' });
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
    expect(tx.replies[0]?.result).toMatchObject({ ok: false, error: { message: 'already terminal' } });
  });
});
