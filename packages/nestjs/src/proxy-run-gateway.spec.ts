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

  it("routes only this run's tenant events to subscribe", () => {
    const tx = fakeTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 5000);
    const seen: Array<{ runId: string; type: string }> = [];
    gw.subscribe('r1', (e) => seen.push(e));
    tx.emitEvent({ tenant: 'acme', event: { runId: 'r2', type: 'run.completed' } });
    tx.emitEvent({ tenant: 'acme', event: { runId: 'r1', type: 'run.completed' } });
    expect(seen).toHaveLength(1);
  });
});
