import type {
  RunDetail,
  RunGateway,
  RunReply,
  RunRequest,
  RunRequestKind,
  RunWaiting,
  StateStore,
  StepCheckpoint,
  Transport,
  WorkflowEngine,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyRunGateway } from './proxy-run-gateway';
import { RunRequestResponder, type RunRequestTransport } from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';

/**
 * A tenant and the control plane upgrade on their own schedules, so for the length of a rolling
 * upgrade either side can be a release behind the other. The current `ProxyRunGateway` and
 * `RunRequestResponder` are exercised here against faithful copies of their 0.46.3 counterparts
 * (the release before summarized run details and paged fan members), over a wire that JSON-encodes
 * every message the way the BullMQ transport does.
 */

// --- 0.46.3, copied from packages/nestjs/src/{run-request-responder,proxy-run-gateway}.ts -------

/** The 0.46.3 control plane's gateway: no `RunDetailOptions`, no `getFanMembers`, no `getRun`. */
type LegacyGateway = Pick<
  RunGateway,
  | 'getRunDetail'
  | 'listRuns'
  | 'runFacets'
  | 'runValueFacets'
  | 'workerHealth'
  | 'waitingFor'
  | 'cancel'
  | 'retry'
  | 'continue'
  | 'retryWithInput'
  | 'redispatchPending'
>;

class LegacyRunRequestResponder {
  constructor(
    private readonly transport: RunRequestTransport,
    private readonly gateway: LegacyGateway,
  ) {}

  start(): void {
    this.transport.onRunRequest(async (msg) => {
      const reply = await this.handle(msg);
      await this.transport.publishRunReply(reply);
    });
  }

  private async handle(msg: RunRequest): Promise<RunReply> {
    const body = msg.body as RunRequestKind & { runId: string };
    if (body.kind === 'listRuns') {
      const data = await this.gateway.listRuns({ ...body.query, namespace: msg.tenant });
      return { requestId: msg.requestId, result: { ok: true, data } };
    }
    if (body.kind === 'workerHealth') {
      const all = await this.gateway.workerHealth();
      const data = all.filter((h) => h.group.endsWith(`@${msg.tenant}`));
      return { requestId: msg.requestId, result: { ok: true, data } };
    }
    if (body.kind === 'waitingFor') {
      const all = await this.gateway.waitingFor(body.runIds);
      const owned = await Promise.all(
        Object.entries(all).map(async ([runId, waiting]) => {
          const runDetail = await this.gateway.getRunDetail(runId);
          return runDetail && runDetail.run.namespace === msg.tenant
            ? ([runId, waiting] as const)
            : undefined;
        }),
      );
      const data: Record<string, RunWaiting> = {};
      for (const entry of owned) {
        if (entry) data[entry[0]] = entry[1];
      }
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    const detail = await this.gateway.getRunDetail(body.runId);
    if (detail && detail.run.namespace !== msg.tenant) {
      return {
        requestId: msg.requestId,
        result: {
          ok: false,
          error: { message: 'run belongs to another tenant', code: 'cross-tenant' },
        },
      };
    }
    if (body.kind === 'getRunDetail') {
      return { requestId: msg.requestId, result: { ok: true, data: detail } };
    }
    try {
      const data = await this.callVerb(body);
      return { requestId: msg.requestId, result: { ok: true, data } };
    } catch (err) {
      return {
        requestId: msg.requestId,
        result: { ok: false, error: { message: err instanceof Error ? err.message : String(err) } },
      };
    }
  }

  private callVerb(body: RunRequestKind): Promise<unknown> | undefined {
    switch (body.kind) {
      case 'cancel':
        return this.gateway.cancel(body.runId, body.opts);
      case 'retry':
        return this.gateway.retry(body.runId);
      case 'continue':
        return this.gateway.continue(body.runId);
      case 'retryWithInput':
        return this.gateway.retryWithInput(body.runId, body.input);
      case 'redispatch':
        return this.gateway.redispatchPending(body.runId);
    }
    return undefined;
  }
}

/** The 0.46.3 tenant proxy, cut to the verbs this suite drives. */
class LegacyProxyRunGateway {
  private readonly pending = new Map<
    string,
    { resolve(d: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly transport: Transport,
    private readonly tenant: string,
    private readonly timeoutMs = 10_000,
  ) {
    this.transport.onRunReply?.((reply) => {
      const pending = this.pending.get(reply.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.requestId);
      if (reply.result.ok) pending.resolve(reply.result.data);
      else pending.reject(new Error(reply.result.error.message));
    });
  }

  private request<T>(body: RunRequestKind): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = globalThis.crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(`control plane did not respond to ${body.kind} within ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (d: unknown) => void, reject, timer });
      void this.transport.dispatchRunRequest?.({ requestId, tenant: this.tenant, body });
    });
  }

  getRunDetail(runId: string): Promise<RunDetail | null> {
    return this.request<RunDetail | null>({ kind: 'getRunDetail', runId });
  }

  cancel(runId: string): Promise<unknown> {
    return this.request({ kind: 'cancel', runId });
  }
}

// --- the wire -----------------------------------------------------------------------------------

/** Requests go to the responders in turn, like one queue drained by several control-plane pods;
 *  replies reach every tenant. Each message crosses as JSON, so `undefined` fields drop off. */
function wire() {
  const requestHandlers: Array<(msg: RunRequest) => Promise<void>> = [];
  const replyHandlers: Array<(reply: RunReply) => void> = [];
  const sent: RunRequestKind[] = [];
  let next = 0;
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const tenantSide = {
    onRunReply: (handler: (reply: RunReply) => void) => {
      replyHandlers.push(handler);
    },
    dispatchRunRequest: async (msg: RunRequest) => {
      sent.push(msg.body);
      const handler = requestHandlers[next++ % requestHandlers.length];
      setImmediate(() => void handler?.(json(msg)));
    },
  } as unknown as Transport;
  const controlPlaneSide: RunRequestTransport = {
    onRunRequest: (handler) => {
      requestHandlers.push(handler);
    },
    publishRunReply: async (reply) => {
      const encoded = json(reply);
      setImmediate(() => {
        for (const h of replyHandlers) h(encoded);
      });
    },
  };
  return { tenantSide, controlPlaneSide, sent, kinds: () => sent.map((b) => b.kind) };
}

// --- one run with a 30-member fan ---------------------------------------------------------------

const FAN = 'fan:1';
const WIDE = 10;

function run(): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'wf',
    workflowVersion: '1',
    status: 'running',
    input: null,
    namespace: 'acme',
    createdAt: new Date('2026-10-21T00:00:00Z'),
    updatedAt: new Date('2026-10-21T00:00:00Z'),
  };
}

function checkpoint(seq: number, extra: Partial<StepCheckpoint> = {}): StepCheckpoint {
  const at = new Date(Date.UTC(2026, 9, 21, 0, 0, seq));
  return {
    runId: 'r1',
    seq,
    name: 'charge',
    kind: 'remote',
    stepId: `r1:${seq}`,
    status: 'completed',
    attempts: 1,
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
    ...extra,
  } as StepCheckpoint;
}

function timeline(): StepCheckpoint[] {
  const members = Array.from({ length: 30 }, (_, i) =>
    checkpoint(i + 1, {
      parallelGroup: FAN,
      ...(i % 7 === 0 ? { status: 'failed' as const } : {}),
    }),
  );
  return [
    checkpoint(0, { name: 'prepare' }),
    ...members,
    checkpoint(31, { name: 'spawn:audit', output: 'child-a' }),
    checkpoint(32, { name: 'signal:child:child-b' }),
  ];
}

/** The current control plane: the real `StoreRunGateway` over a store holding the one run. */
function currentGateway(): StoreRunGateway {
  const store = {
    getRun: async (id: string) => (id === 'r1' ? run() : null),
    listCheckpoints: async (id: string) => (id === 'r1' ? timeline() : []),
  } as unknown as StateStore;
  // The child-edge read lists children in its own order, not the timeline's.
  const engine = {
    getRunChildren: async () => ['child-b', 'child-a'],
  } as unknown as WorkflowEngine;
  return new StoreRunGateway(store, engine);
}

/** The 0.46.3 control plane's gateway, which read every run detail in full. */
function legacyGateway(): LegacyGateway {
  const gateway = currentGateway();
  return {
    getRunDetail: (runId: string) => gateway.getRunDetail(runId),
    listRuns: (q) => gateway.listRuns(q),
    runFacets: (q) => gateway.runFacets(q),
    runValueFacets: (a, q, o) => gateway.runValueFacets(a, q, o),
    workerHealth: async () => [],
    waitingFor: async () => ({}),
    cancel: async (runId: string) => ({ runId, status: 'cancelled' }) as never,
    retry: async () => null,
    continue: async () => null,
    retryWithInput: async () => null,
    redispatchPending: async () => null,
  };
}

function controlPlane(w: ReturnType<typeof wire>, version: 'current' | '0.46.3'): void {
  if (version === 'current') new RunRequestResponder(w.controlPlaneSide, currentGateway()).start();
  else new LegacyRunRequestResponder(w.controlPlaneSide, legacyGateway()).start();
}

/** Every value a JSON hop would leave behind, to compare details that crossed the wire. */
const wired = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

afterEach(() => {
  vi.useRealTimers();
});

describe('run gateway version skew', () => {
  describe('current tenant, current control plane', () => {
    it('summarizes on the control plane and pages fans there', async () => {
      const w = wire();
      controlPlane(w, 'current');
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

      const detail = await proxy.getRunDetail('r1', { summarizeFansOver: WIDE });
      expect(detail?.fans).toHaveLength(1);
      const page = await proxy.getFanMembers('r1', FAN, { offset: 0, limit: 5 });
      expect(page?.total).toBe(30);
      expect(w.kinds()).toEqual(['getRunDetail', 'getFanMembers']);
    });
  });

  describe('current tenant, 0.46.3 control plane', () => {
    it('summarizes the full detail itself, exactly as the control plane would have', async () => {
      const expected = wired(
        await currentGateway().getRunDetail('r1', { summarizeFansOver: WIDE }),
      );
      const w = wire();
      controlPlane(w, '0.46.3');
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

      const detail = await proxy.getRunDetail('r1', { summarizeFansOver: WIDE });

      expect(detail?.fans?.map((f) => [f.group, f.size, f.counts])).toEqual([
        [FAN, 30, { completed: 25, failed: 5 }],
      ]);
      expect(detail?.timeline.map((cp) => cp.name)).toEqual([
        'prepare',
        'spawn:audit',
        'signal:child:child-b',
      ]);
      expect(detail).toEqual(expected);
    });

    it('pages a fan out of the full detail, without waiting for a timeout', async () => {
      const w = wire();
      controlPlane(w, '0.46.3');
      // A timeout this long would fail the test on its own: the fallback has to be immediate.
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme', 60_000);

      const started = Date.now();
      const page = await proxy.getFanMembers('r1', FAN, { offset: 2, limit: 3 });

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(page?.total).toBe(30);
      expect(page?.items.map((cp) => cp.seq)).toEqual([3, 4, 5]);
      const failed = await proxy.getFanMembers('r1', FAN, { failedOnly: true });
      expect(failed?.items.map((cp) => cp.seq)).toEqual([1, 8, 15, 22, 29]);
    });

    it('answers null for a fan of a run that does not exist', async () => {
      const w = wire();
      controlPlane(w, '0.46.3');
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme');
      await expect(proxy.getFanMembers('missing', FAN, {})).resolves.toBeNull();
    });

    it('remembers the control plane is old for a while, then asks again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const w = wire();
      controlPlane(w, '0.46.3');
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme', 10_000, 30_000);

      await proxy.getFanMembers('r1', FAN, {});
      await proxy.getFanMembers('r1', FAN, {});
      vi.advanceTimersByTime(30_001);
      await proxy.getFanMembers('r1', FAN, {});

      expect(w.kinds()).toEqual([
        'getFanMembers',
        'getRunDetail',
        'getRunDetail',
        'getFanMembers',
        'getRunDetail',
      ]);
    });

    it('keeps the tenant boundary: a cross-tenant fan stays refused', async () => {
      const w = wire();
      controlPlane(w, '0.46.3');
      const proxy = new ProxyRunGateway(w.tenantSide, 'other-tenant');
      await expect(proxy.getFanMembers('r1', FAN, {})).rejects.toThrow(/another tenant/);
      await expect(proxy.getRunDetail('r1', { summarizeFansOver: WIDE })).rejects.toThrow(
        /another tenant/,
      );
    });

    it('leaves the verbs both releases share untouched', async () => {
      const w = wire();
      controlPlane(w, '0.46.3');
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme');
      await expect(proxy.cancel('r1')).resolves.toEqual({ runId: 'r1', status: 'cancelled' });
      const full = await proxy.getRunDetail('r1');
      expect(full?.timeline).toHaveLength(33);
      expect(full?.fans).toBeUndefined();
    });
  });

  describe('0.46.3 tenant, current control plane', () => {
    it('gets the full detail, exactly as a 0.46.3 control plane sent it', async () => {
      const before = wire();
      controlPlane(before, '0.46.3');
      const expected = await new LegacyProxyRunGateway(before.tenantSide, 'acme').getRunDetail(
        'r1',
      );

      const w = wire();
      controlPlane(w, 'current');
      const detail = await new LegacyProxyRunGateway(w.tenantSide, 'acme').getRunDetail('r1');

      expect(detail).toEqual(expected);
      expect(detail?.timeline).toHaveLength(33);
      expect(detail).not.toHaveProperty('fans');
    });

    it('cancels and refuses another tenant as before', async () => {
      const w = wire();
      controlPlane(w, 'current');
      const gateway = currentGateway();
      vi.spyOn(gateway, 'cancel').mockResolvedValue({ runId: 'r1', status: 'cancelled' } as never);
      const w2 = wire();
      new RunRequestResponder(w2.controlPlaneSide, gateway).start();

      await expect(new LegacyProxyRunGateway(w2.tenantSide, 'acme').cancel('r1')).resolves.toEqual({
        runId: 'r1',
        status: 'cancelled',
      });
      await expect(
        new LegacyProxyRunGateway(w.tenantSide, 'other-tenant').cancel('r1'),
      ).rejects.toThrow(/another tenant/);
    });
  });

  describe('a control plane halfway through its own rolling upgrade', () => {
    it('serves a summarized detail and its fan pages whichever pod answers', async () => {
      const w = wire();
      controlPlane(w, 'current');
      controlPlane(w, '0.46.3');
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

      for (let i = 0; i < 4; i++) {
        const detail = await proxy.getRunDetail('r1', { summarizeFansOver: WIDE });
        expect(detail?.fans).toHaveLength(1);
        expect(detail?.timeline).toHaveLength(3);
      }
      const page = await proxy.getFanMembers('r1', FAN, { limit: 4 });
      expect(page?.items.map((cp) => cp.seq)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('a tenant newer than the current control plane', () => {
    it('is told at once that a verb is unknown, without the gateway being touched', async () => {
      const w = wire();
      const gateway = currentGateway();
      const getRunDetail = vi.spyOn(gateway, 'getRunDetail');
      new RunRequestResponder(w.controlPlaneSide, gateway).start();
      const replies: RunReply[] = [];
      w.tenantSide.onRunReply?.((r) => replies.push(r));

      await w.tenantSide.dispatchRunRequest?.({
        requestId: 'q1',
        tenant: 'acme',
        body: { kind: 'getFanStats', runId: 'r1' } as unknown as RunRequestKind,
      });
      await vi.waitFor(() => expect(replies).toHaveLength(1));

      expect(replies[0]?.result).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'unsupported-request' }),
      });
      expect(getRunDetail).not.toHaveBeenCalled();
    });

    it('falls back to paging locally when the control plane says the verb is unsupported', async () => {
      const w = wire();
      const gateway = currentGateway();
      const respond = new RunRequestResponder(w.controlPlaneSide, gateway);
      // A control plane that knows the error code but not the verb.
      const handle = (respond as unknown as { handle(m: RunRequest): Promise<RunReply> }).handle;
      (respond as unknown as { handle(m: RunRequest): Promise<RunReply> }).handle = function (
        this: RunRequestResponder,
        msg,
      ) {
        if (msg.body.kind === 'getFanMembers') {
          return Promise.resolve({
            requestId: msg.requestId,
            result: { ok: false, error: { message: 'unknown', code: 'unsupported-request' } },
          });
        }
        return handle.call(this, msg);
      };
      respond.start();
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

      const page = await proxy.getFanMembers('r1', FAN, { limit: 2 });
      expect(page?.items.map((cp) => cp.seq)).toEqual([1, 2]);
      expect(w.kinds()).toEqual(['getFanMembers', 'getRunDetail']);
    });
  });

  it('a gateway that throws is answered with an error, not left to the timeout', async () => {
    const w = wire();
    const gateway = currentGateway();
    vi.spyOn(gateway, 'getRun').mockRejectedValue(new Error('db down'));
    new RunRequestResponder(w.controlPlaneSide, gateway).start();
    const proxy = new ProxyRunGateway(w.tenantSide, 'acme', 60_000);
    await expect(proxy.retry('r1')).rejects.toThrow(/db down/);
  });
});
