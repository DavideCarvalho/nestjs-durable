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

  it('passes getRunDetail options through, and pages a fan only for the owning tenant', async () => {
    const getFanMembers = vi.fn(async () => ({ items: [], total: 0 }));
    const gw = fakeGateway({ getFanMembers });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();

    await tx.deliver({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'getRunDetail', runId: 'r1', options: { summarizeFansOver: 50 } },
    });
    expect(gw.getRunDetail).toHaveBeenCalledWith('r1', { summarizeFansOver: 50 });

    await tx.deliver({
      requestId: 'q2',
      tenant: 'acme',
      body: { kind: 'getFanMembers', runId: 'r1', group: 'steps:0:9', query: { limit: 5 } },
    });
    expect(getFanMembers).toHaveBeenCalledWith('r1', 'steps:0:9', { limit: 5 });
    expect(tx.replies[1]).toMatchObject({ requestId: 'q2', result: { ok: true } });

    await tx.deliver({
      requestId: 'q3',
      tenant: 'beta',
      body: { kind: 'getFanMembers', runId: 'r1', group: 'steps:0:9', query: {} },
    });
    expect(getFanMembers).toHaveBeenCalledTimes(1);
    expect(tx.replies[2]).toMatchObject({ result: { ok: false } });
  });

  it('checks ownership on the run alone when the gateway can read it, never the timeline', async () => {
    const getRun = vi.fn(async (id: string) => fakeRun(id, 'acme'));
    const getFanMembers = vi.fn(async () => ({ items: [], total: 0 }));
    const gw = fakeGateway({ getRun, getFanMembers });
    const tx = fakeTransport();
    new RunRequestResponder(tx, gw).start();

    await tx.deliver({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'getFanMembers', runId: 'r1', group: 'steps:0:9', query: {} },
    });
    await tx.deliver({ requestId: 'q2', tenant: 'acme', body: { kind: 'cancel', runId: 'r1' } });
    await tx.deliver({
      requestId: 'q3',
      tenant: 'beta',
      body: { kind: 'retry', runId: 'r1' },
    });

    expect(gw.getRunDetail).not.toHaveBeenCalled();
    expect(getRun).toHaveBeenCalledTimes(3);
    expect(getFanMembers).toHaveBeenCalledTimes(1);
    expect(gw.cancel).toHaveBeenCalledTimes(1);
    expect(gw.retry).not.toHaveBeenCalled();
    expect(tx.replies[2]).toMatchObject({ result: { ok: false } });
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

  it('acts on a schedule of the requester namespace only, and reads another one as missing', async () => {
    const schedule = (namespace: string) =>
      ({ id: 's1', workflow: 'wf', input: null, namespace }) as never;
    const scheduleAction = vi.fn(async () => ({ runId: 'started', status: 'pending' }) as never);
    const tx = fakeTransport();
    new RunRequestResponder(
      tx,
      fakeGateway({ getSchedule: vi.fn(async () => schedule('beta')), scheduleAction }),
    ).start();
    await tx.deliver({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'schedule', id: 's1', action: 'trigger' },
    });
    expect(tx.replies[0]?.result).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(scheduleAction).not.toHaveBeenCalled();

    await tx.deliver({
      requestId: 'q2',
      tenant: 'beta',
      body: { kind: 'schedule', id: 's1', action: 'trigger' },
    });
    expect(tx.replies[1]?.result).toEqual({
      ok: true,
      data: { runId: 'started', status: 'pending' },
    });
    expect(scheduleAction).toHaveBeenCalledWith('s1', 'trigger');

    await tx.deliver({
      requestId: 'q3',
      tenant: 'beta',
      body: { kind: 'schedule', id: 's1', action: 'drop' as never },
    });
    expect(tx.replies[2]?.result).toMatchObject({ ok: false, error: { code: 'bad-request' } });
  });

  it('signals only a run of the requester namespace, and buffers nothing for a token no run waits on', async () => {
    const signal = vi.fn(async () => ({ runId: 'r1', status: 'running' }) as RunResult);
    const waiters: Record<string, string> = { 'tok-acme': 'r1', 'tok-beta': 'r2' };
    const tx = fakeTransport();
    new RunRequestResponder(
      tx,
      fakeGateway({
        getRun: vi.fn(async (id: string) => fakeRun(id, id === 'r1' ? 'acme' : 'beta')),
        signalWaiter: vi.fn(async (token: string) => waiters[token] ?? null),
        signal,
      }),
    ).start();

    for (const token of ['tok-beta', 'tok-nobody']) {
      await tx.deliver({
        requestId: token,
        tenant: 'acme',
        body: { kind: 'signal', token, payload: 1 },
      });
    }
    expect(tx.replies.map((r) => r.result)).toEqual([
      { ok: true, data: null },
      { ok: true, data: null },
    ]);
    expect(signal).not.toHaveBeenCalled();

    await tx.deliver({
      requestId: 'q3',
      tenant: 'acme',
      body: { kind: 'signal', token: 'tok-acme', payload: 1 },
    });
    expect(signal).toHaveBeenCalledWith('tok-acme', 1);
    expect(tx.replies[2]?.result).toEqual({ ok: true, data: { runId: 'r1', status: 'running' } });
  });

  it('answers a signal or schedule request unsupported when its gateway cannot serve it', async () => {
    const tx = fakeTransport();
    new RunRequestResponder(tx, fakeGateway()).start();
    await tx.deliver({
      requestId: 'q1',
      tenant: 'acme',
      body: { kind: 'signal', token: 't', payload: null },
    });
    await tx.deliver({
      requestId: 'q2',
      tenant: 'acme',
      body: { kind: 'schedule', id: 's', action: 'pause' },
    });
    expect(tx.replies.map((r) => r.result)).toMatchObject([
      { ok: false, error: { code: 'unsupported-request' } },
      { ok: false, error: { code: 'unsupported-request' } },
    ]);
  });

  it('signalWithStart: starts in the requester namespace, refuses another tenant run or waiter, keeps only a granted customer claim', async () => {
    const signalWithStartForTenant = vi.fn(async () => ({ runId: 'c1', signalled: true }));
    const runs: Record<string, WorkflowRun> = { theirs: fakeRun('theirs', 'beta') };
    const waiters: Record<string, string> = { 'tok-beta': 'theirs' };
    const tx = fakeTransport();
    new RunRequestResponder(
      tx,
      fakeGateway({
        getRun: vi.fn(async (id: string) => runs[id] ?? null),
        signalWaiter: vi.fn(async (token: string) => waiters[token] ?? null),
        signalWithStartForTenant,
      }),
      {
        verifyTenant: ({ token }) =>
          token === 'acme-token' ? { tenant: 'acme', capabilities: ['tenancy:org-1'] } : null,
      },
    ).start();
    const send = (requestId: string, start: Record<string, unknown>, token: string) =>
      tx.deliver({
        requestId,
        tenant: 'acme-token',
        body: {
          kind: 'signalWithStart',
          start: { workflow: 'counter', input: {}, ...start } as never,
          signal: { token, payload: 1 },
        },
      });

    await send('own', { runId: 'c1', tenantId: 'org-1' }, 'c1:add');
    expect(signalWithStartForTenant).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'c1', tenant: 'acme' }),
      'acme',
      { tenantId: 'org-1' },
      { token: 'c1:add', payload: 1 },
    );
    await send('claim', { runId: 'c2', tenantId: 'org-2' }, 'c2:add');
    expect(signalWithStartForTenant.mock.calls[1]?.[2]).toEqual({ tenantId: null });

    await send('run', { runId: 'theirs' }, 'theirs:add');
    await send('waiter', { runId: 'c3' }, 'tok-beta');
    await send('bad', { runId: '' }, 'x');
    expect(tx.replies.map((r) => (r.result.ok ? 'ok' : r.result.error.code))).toEqual([
      'ok',
      'ok',
      'cross-tenant',
      'cross-tenant',
      'bad-request',
    ]);
    expect(signalWithStartForTenant).toHaveBeenCalledTimes(2);
  });

  it('publishEvent is answered over the requester namespace only, and unsupported without the gateway verb', async () => {
    const publishEventForTenant = vi.fn(async () => 1);
    const tx = fakeTransport();
    new RunRequestResponder(tx, fakeGateway({ publishEventForTenant })).start();
    await tx.deliver({
      requestId: 'p',
      tenant: 'acme',
      body: { kind: 'publishEvent', name: 'paid', payload: { n: 1 } },
    });
    expect(publishEventForTenant).toHaveBeenCalledWith('paid', { n: 1 }, 'acme');
    expect(tx.replies[0]?.result).toEqual({ ok: true, data: 1 });

    const old = fakeTransport();
    new RunRequestResponder(old, fakeGateway()).start();
    await old.deliver({
      requestId: 'p',
      tenant: 'acme',
      body: { kind: 'publishEvent', name: 'paid', payload: {} },
    });
    expect(old.replies[0]?.result).toMatchObject({
      ok: false,
      error: { code: 'unsupported-request' },
    });
  });
});
