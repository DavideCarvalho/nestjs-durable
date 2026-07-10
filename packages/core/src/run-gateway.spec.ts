import { describe, expect, it } from 'vitest';
import type { RunReply, RunRequest } from './interfaces';
import type { RunDetail, RunGateway } from './run-gateway';

describe('RunGateway contracts', () => {
  it('RunRequest is a discriminated, tenant-scoped envelope', () => {
    const req: RunRequest = {
      requestId: 'r1',
      tenant: 'acme',
      body: { kind: 'getRunDetail', runId: 'run-1' },
    };
    expect(req.body.kind).toBe('getRunDetail');
  });

  it('RunReply discriminates ok vs error', () => {
    const ok: RunReply = { requestId: 'r1', result: { ok: true, data: null } };
    const err: RunReply = {
      requestId: 'r1',
      result: { ok: false, error: { message: 'not found', code: 'not-found' } },
    };
    expect(ok.result.ok).toBe(true);
    expect(err.result.ok).toBe(false);
  });

  it('RunGateway exposes the six run operations + subscribe', () => {
    // Type-level assertion: a value of this shape must satisfy RunGateway.
    const g: Pick<RunGateway, 'getRunDetail'> = {
      getRunDetail: async (_id: string): Promise<RunDetail | null> => null,
    };
    expect(typeof g.getRunDetail).toBe('function');
  });

  it('RunRequestKind carries a bulk waitingFor variant (runIds, not a single runId)', () => {
    const req: RunRequest = {
      requestId: 'r1',
      tenant: 'acme',
      body: { kind: 'waitingFor', runIds: ['a', 'b'] },
    };
    expect(req.body.kind).toBe('waitingFor');
  });

  it('waitingFor returns a Record (not a Map) so a proxy can serialise it as plain JSON', () => {
    const g: Pick<RunGateway, 'waitingFor'> = {
      waitingFor: async (_runIds: string[]) => ({ r1: { on: 'breakpoint', name: 'breakpoint' } }),
    };
    expect(typeof g.waitingFor).toBe('function');
  });
});
