import { describe, expect, it, vi } from 'vitest';
import { ProxyRunGateway } from './proxy-run-gateway';

function fakeTransport() {
  let onReply: (reply: { requestId: string; result: unknown }) => void = () => {};
  let onEvt: (evt: { tenant: string; event: { runId: string; type: string } }) => void = () => {};
  const requests: Array<{ requestId: string; tenant: string; body: unknown }> = [];
  return {
    onRunReply: (handler: (reply: { requestId: string; result: unknown }) => void) => {
      onReply = handler;
    },
    onTenantEvent: (
      _tenant: string,
      handler: (evt: { tenant: string; event: { runId: string; type: string } }) => void,
    ) => {
      onEvt = handler;
      return () => {};
    },
    dispatchRunRequest: async (msg: { requestId: string; tenant: string; body: unknown }) => {
      requests.push(msg);
    },
    emitReply: (reply: { requestId: string; result: unknown }) => onReply(reply),
    emitEvent: (evt: { tenant: string; event: { runId: string; type: string } }) => onEvt(evt),
    requests,
  };
}

describe('ProxyRunGateway', () => {
  it('resolves a getRunDetail when the correlated reply arrives', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.getRunDetail('r1');
    const req = tx.requests[0];
    expect(req).toMatchObject({ tenant: 'acme', body: { kind: 'getRunDetail', runId: 'r1' } });
    tx.emitReply({
      requestId: req.requestId,
      result: { ok: true, data: { run: { id: 'r1' }, timeline: [], children: [] } },
    });
    await expect(p).resolves.toMatchObject({ run: { id: 'r1' } });
  });

  it('reports tenant topology with its partition name (no round-trip)', () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    expect(gw.topology()).toEqual({ role: 'tenant', tenant: 'acme' });
    expect(tx.requests).toHaveLength(0);
  });

  it('round-trips workerHealth and resolves with the operator-scoped groups', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.workerHealth();
    const req = tx.requests[0];
    expect(req).toMatchObject({ tenant: 'acme', body: { kind: 'workerHealth' } });
    tx.emitReply({
      requestId: req.requestId,
      result: { ok: true, data: [{ group: 'pipeline@acme', depth: 2, liveWorkers: [] }] },
    });
    await expect(p).resolves.toMatchObject([{ group: 'pipeline@acme', depth: 2 }]);
  });

  it('rejects with the operator error', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.cancel('r1');
    tx.emitReply({
      requestId: tx.requests[0].requestId,
      result: { ok: false, error: { message: 'nope', code: 'cross-tenant' } },
    });
    await expect(p).rejects.toThrow(/nope/);
  });

  it('rejects on timeout when no reply arrives', async () => {
    vi.useFakeTimers();
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 1000);
    const p = gw.listRuns({});
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/did not respond/i);
    vi.useRealTimers();
  });

  it('rejects immediately with the dispatch error when dispatchRunRequest rejects, without waiting for the timeout', async () => {
    const tx = fakeTransport();
    tx.dispatchRunRequest = async (msg) => {
      tx.requests.push(msg);
      throw new Error('broker down');
    };
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.cancel('r1');
    await expect(p).rejects.toThrow(/broker down/);
    const requestId = tx.requests[0].requestId;
    // reply for the already-settled request must be a silent no-op, not a double-settle
    tx.emitReply({ requestId, result: { ok: true, data: { should: 'be-ignored' } } });
  });

  it('cancel carries compensate opts across the wire', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    void gw.cancel('r1', { compensate: true });
    expect(tx.requests[0]).toMatchObject({
      tenant: 'acme',
      body: { kind: 'cancel', runId: 'r1', opts: { compensate: true } },
    });
  });

  it('round-trips waitingFor with the whole id list in ONE request, not one per id', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.waitingFor(['r1', 'r2', 'r3']);
    expect(tx.requests).toHaveLength(1);
    const req = tx.requests[0];
    expect(req).toMatchObject({
      tenant: 'acme',
      body: { kind: 'waitingFor', runIds: ['r1', 'r2', 'r3'] },
    });
    tx.emitReply({
      requestId: req.requestId,
      result: { ok: true, data: { r1: { on: 'breakpoint', name: 'breakpoint' } } },
    });
    await expect(p).resolves.toEqual({ r1: { on: 'breakpoint', name: 'breakpoint' } });
  });

  it('round-trips redispatchPending and resolves with the redispatched count', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const p = gw.redispatchPending('r1');
    const req = tx.requests[0];
    expect(req).toMatchObject({ tenant: 'acme', body: { kind: 'redispatch', runId: 'r1' } });
    tx.emitReply({
      requestId: req.requestId,
      result: { ok: true, data: { runId: 'r1', status: 'running', redispatched: 2 } },
    });
    await expect(p).resolves.toMatchObject({ runId: 'r1', redispatched: 2 });
  });

  it("routes only this run's tenant events to subscribe", () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const seen: Array<{ runId: string; type: string }> = [];
    gw.subscribe('r1', (e) => seen.push(e));
    tx.emitEvent({ tenant: 'acme', event: { runId: 'r2', type: 'run.completed' } });
    tx.emitEvent({ tenant: 'acme', event: { runId: 'r1', type: 'run.completed' } });
    expect(seen).toHaveLength(1);
  });

  it('signal: an explicit null is "nobody waits"; an empty reply (a control plane older than the verb) is unsupported', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const nobody = gw.signal('tok', 1, { id: 'd' });
    const req = tx.requests[0];
    expect(req).toMatchObject({
      body: { kind: 'signal', token: 'tok', payload: 1, opts: { id: 'd' } },
    });
    tx.emitReply({ requestId: req.requestId, result: { ok: true, data: null } });
    await expect(nobody).resolves.toBeNull();

    const old = gw.signal('tok', 1);
    tx.emitReply({ requestId: tx.requests[1].requestId, result: { ok: true } });
    await expect(old).rejects.toMatchObject({ code: 'unsupported-request' });
    // Remembered for a while: the next call fails at once, with no round trip.
    await expect(gw.signal('tok', 1)).rejects.toMatchObject({ code: 'unsupported-request' });
    expect(tx.requests).toHaveLength(2);
  });

  it('round-trips signalWithStart and publishEvent as run requests', async () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const sws = gw.signalWithStart(
      { workflow: 'counter', input: {}, runId: 'c1' },
      { token: 'c1:add', payload: 1 },
    );
    expect(tx.requests[0]?.body).toEqual({
      kind: 'signalWithStart',
      start: { workflow: 'counter', input: {}, runId: 'c1' },
      signal: { token: 'c1:add', payload: 1 },
    });
    tx.emitReply({
      requestId: tx.requests[0].requestId,
      result: { ok: true, data: { runId: 'c1', signalled: true } },
    });
    await expect(sws).resolves.toEqual({ runId: 'c1', signalled: true });

    const pub = gw.publishEvent('paid', { n: 1 }, { id: 'e1' });
    expect(tx.requests[1]?.body).toEqual({
      kind: 'publishEvent',
      name: 'paid',
      payload: { n: 1 },
      opts: { id: 'e1' },
    });
    tx.emitReply({ requestId: tx.requests[1].requestId, result: { ok: true, data: 0 } });
    await expect(pub).resolves.toBe(0);
  });
});
