import {
  type DurableTopology,
  type EngineEvent,
  type Heartbeat,
  InMemoryStateStore,
  type RunGateway,
  type RunQuery,
  type RunReply,
  type RunRequest,
  type StepResult,
  type Transport,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableModule, type DurableModuleOptions } from './durable.module';
// Imported from the package's public entry: the facade must expose the tenant-auth helpers.
import { type TenantVerifier, hmacTenantVerifier, signTenantToken } from './index';
import { ProxyRunGateway, RunGatewayError } from './proxy-run-gateway';
import { RunRequestResponder, type RunRequestTransport } from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';

const SECRET = 'responder-secret';
const throwing: TenantVerifier = () => {
  throw new Error('verifier down');
};

function run(id: string, namespace: string): WorkflowRun {
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

function gateway(): RunGateway & { listRuns: ReturnType<typeof vi.fn> } {
  return {
    topology: (): DurableTopology => ({ role: 'control-plane' }),
    getRunDetail: vi.fn(async (id: string) => ({
      run: run(id, 'acme'),
      timeline: [],
      children: [],
    })),
    listRuns: vi.fn(async (q: RunQuery) => [run('x', q.namespace ?? 'default')]),
    cancel: vi.fn(async () => null),
    subscribe: (_fn: (e: EngineEvent) => void) => () => {},
  } as unknown as RunGateway & { listRuns: ReturnType<typeof vi.fn> };
}

function transport(): RunRequestTransport & {
  deliver: (msg: RunRequest) => Promise<void>;
  replies: RunReply[];
} {
  let handler: ((msg: RunRequest) => Promise<void>) | undefined;
  const replies: RunReply[] = [];
  return {
    onRunRequest: (h) => {
      handler = h;
    },
    publishRunReply: async (r) => {
      replies.push(r);
    },
    deliver: async (msg) => handler?.(msg),
    replies,
  };
}

const UNAUTHORIZED = {
  ok: false,
  error: { message: 'invalid or unauthorized tenant token', code: 'unauthorized' },
};

afterEach(() => vi.restoreAllMocks());

describe('RunRequestResponder with verifyTenant', () => {
  it('a valid token derives the tenant, and the wire claim is ignored', async () => {
    const gw = gateway();
    const tx = transport();
    new RunRequestResponder(tx, gw, { verifyTenant: hmacTenantVerifier(SECRET) }).start();
    await tx.deliver({
      requestId: 'q1',
      tenant: signTenantToken('acme', SECRET),
      body: { kind: 'listRuns', query: { namespace: 'beta' } },
    });
    expect(gw.listRuns).toHaveBeenCalledWith({ namespace: 'acme' });
    expect(tx.replies[0]).toMatchObject({ requestId: 'q1', result: { ok: true } });
  });

  it('cross-tenant checks run against the VERIFIED tenant', async () => {
    const gw = gateway(); // every run belongs to 'acme'
    const tx = transport();
    new RunRequestResponder(tx, gw, { verifyTenant: hmacTenantVerifier(SECRET) }).start();
    await tx.deliver({
      requestId: 'q1',
      tenant: signTenantToken('beta', SECRET),
      body: { kind: 'cancel', runId: 'r1' },
    });
    expect(tx.replies[0]?.result).toMatchObject({ ok: false, error: { code: 'cross-tenant' } });
    expect(gw.cancel).not.toHaveBeenCalled();
  });

  it('rejects a missing, tampered or foreign-secret token with the unauthorized reply', async () => {
    const gw = gateway();
    const tx = transport();
    new RunRequestResponder(tx, gw, { verifyTenant: hmacTenantVerifier(SECRET) }).start();
    const sig = signTenantToken('acme', SECRET).split('.').pop();
    const bad = ['acme', '', `beta.${sig}`, signTenantToken('acme', 'other-secret')];
    for (const [i, tenant] of bad.entries()) {
      await tx.deliver({ requestId: `q${i}`, tenant, body: { kind: 'listRuns', query: {} } });
    }
    // Byte-identical to Agora's reply, so either tenant can recognise it.
    expect(tx.replies).toEqual(bad.map((_, i) => ({ requestId: `q${i}`, result: UNAUTHORIZED })));
    expect(gw.listRuns).not.toHaveBeenCalled();
  });

  it('a verifier that throws becomes an error reply, never a missing one', async () => {
    const tx = transport();
    new RunRequestResponder(tx, gateway(), { verifyTenant: throwing }).start();
    await tx.deliver({ requestId: 'q1', tenant: 'acme', body: { kind: 'listRuns', query: {} } });
    expect(tx.replies).toEqual([
      { requestId: 'q1', result: { ok: false, error: { message: 'verifier down' } } },
    ]);
  });

  it('without a verifier the wire tenant is trusted verbatim, and it warns by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gw = gateway();
    const tx = transport();
    new RunRequestResponder(tx, gw).start();
    expect(warn).toHaveBeenCalledOnce();
    await tx.deliver({ requestId: 'q1', tenant: 'beta', body: { kind: 'listRuns', query: {} } });
    expect(gw.listRuns).toHaveBeenCalledWith({ namespace: 'beta' });
  });

  it('does not warn with a verifier, nor with warnWithoutVerifier: false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new RunRequestResponder(transport(), gateway(), { verifyTenant: hmacTenantVerifier(SECRET) });
    new RunRequestResponder(transport(), gateway(), { warnWithoutVerifier: false });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ProxyRunGateway tenant token', () => {
  function proxyTransport() {
    const requests: RunRequest[] = [];
    return {
      onRunReply: () => {},
      onTenantEvent: vi.fn(() => () => {}),
      dispatchRunRequest: async (msg: RunRequest) => {
        requests.push(msg);
      },
      requests,
    } as unknown as Transport & { requests: RunRequest[]; onTenantEvent: ReturnType<typeof vi.fn> };
  }

  it('presents a static token in the tenant field, keeping topology and live-tail on the partition', async () => {
    const tx = proxyTransport();
    const token = signTenantToken('acme', SECRET);
    const gw = new ProxyRunGateway(tx, 'acme', 50, undefined, token);
    void gw.listRuns({}).catch(() => undefined);
    await vi.waitFor(() => expect(tx.requests).toHaveLength(1));
    expect(tx.requests[0]?.tenant).toBe(token);
    expect(gw.topology()).toEqual({ role: 'tenant', tenant: 'acme' });
    gw.subscribe('r1', () => {});
    expect(tx.onTenantEvent).toHaveBeenCalledWith('acme', expect.any(Function));
  });

  it('calls a token provider before every request', async () => {
    const tx = proxyTransport();
    let n = 0;
    const gw = new ProxyRunGateway(tx, 'acme', 50, undefined, async () => `token-${++n}`);
    void gw.listRuns({}).catch(() => undefined);
    void gw.workerHealth().catch(() => undefined);
    await vi.waitFor(() => expect(tx.requests).toHaveLength(2));
    expect(tx.requests.map((r) => r.tenant).sort()).toEqual(['token-1', 'token-2']);
  });

  it('without a token the raw partition is sent (unchanged)', async () => {
    const tx = proxyTransport();
    void new ProxyRunGateway(tx, 'acme', 50).listRuns({}).catch(() => undefined);
    await vi.waitFor(() => expect(tx.requests).toHaveLength(1));
    expect(tx.requests[0]?.tenant).toBe('acme');
  });

  it('round-trips through a verifying responder; a forged token rejects with code unauthorized', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...run('mine', 'acme'), status: 'completed' });
    await store.createRun({ ...run('theirs', 'beta'), status: 'completed' });
    const operator = new StoreRunGateway(store, new WorkflowEngine({ store }));
    let onRequest: ((msg: RunRequest) => Promise<void>) | undefined;
    let onReply: ((reply: RunReply) => void) | undefined;
    const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const tx = {
      dispatchRunRequest: async (msg: RunRequest) => onRequest?.(wire(msg)),
      onRunReply: (h: (reply: RunReply) => void) => {
        onReply = h;
      },
    } as unknown as Transport;
    new RunRequestResponder(
      {
        onRunRequest: (h) => {
          onRequest = h;
        },
        publishRunReply: async (r) => onReply?.(wire(r)),
      },
      operator,
      { verifyTenant: hmacTenantVerifier(SECRET) },
    ).start();

    const tenant = new ProxyRunGateway(
      tx,
      'acme',
      1000,
      undefined,
      signTenantToken('acme', SECRET),
    );
    expect((await tenant.listRuns({})).map((r) => r.id)).toEqual(['mine']);

    const forged = new ProxyRunGateway(tx, 'beta', 1000, undefined, signTenantToken('beta', 'x'));
    const rejected = await forged.listRuns({}).catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(RunGatewayError);
    expect(rejected).toMatchObject({
      message: 'invalid or unauthorized tenant token',
      code: 'unauthorized',
    });
  });

  it('starts the request timeout only once the token provider has resolved', async () => {
    vi.useFakeTimers();
    try {
      const tx = proxyTransport();
      let release: (token: string) => void = () => {};
      const slowToken = () =>
        new Promise<string>((r) => {
          release = r;
        });
      const gw = new ProxyRunGateway(tx, 'acme', 100, undefined, slowToken);
      let settled: string | undefined;
      void gw.listRuns({}).then(
        () => {
          settled = 'resolved';
        },
        (err: Error) => {
          settled = err.message;
        },
      );
      // The provider takes longer than the whole timeout: that time must not count.
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBeUndefined();
      expect(tx.requests).toHaveLength(0);
      release('token-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(tx.requests.map((r) => r.tenant)).toEqual(['token-1']);
      // The round trip gets its own full deadline from dispatch.
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe('control plane did not respond to listRuns within 100ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a token provider that rejects fails the request', async () => {
    const tx = proxyTransport();
    const gw = new ProxyRunGateway(tx, 'acme', 1000, undefined, async () => {
      throw new Error('token service down');
    });
    await expect(gw.listRuns({})).rejects.toThrow('token service down');
    expect(tx.requests).toHaveLength(0);
  });
});

/** A broker-like operator transport that carries the run-request protocol. */
class BrokerTransport implements Transport {
  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  onRunRequest(_handler: (msg: RunRequest) => Promise<void>): void {}
  async publishRunReply(_reply: RunReply): Promise<void> {}
}

describe('DurableModule missing-verifier warning (mirrors Agora: only an explicit control plane)', () => {
  async function boot(extra: Partial<DurableModuleOptions>): Promise<string[]> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new BrokerTransport(),
          ...extra,
        }),
      ],
    }).compile();
    await moduleRef.init();
    await moduleRef.close();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    return messages.filter((m) => m.includes('WITHOUT a tenant verifier'));
  }

  it('a plain operator app (role inferred from store) boots silently', async () => {
    expect(await boot({})).toEqual([]);
  });

  it("an explicit topology: { role: 'control-plane' } without a verifier warns", async () => {
    expect(await boot({ topology: { role: 'control-plane' } })).toHaveLength(1);
  });

  it('an explicit control plane with verifyTenant boots silently', async () => {
    expect(
      await boot({
        topology: { role: 'control-plane' },
        verifyTenant: hmacTenantVerifier(SECRET),
      }),
    ).toEqual([]);
  });
});
