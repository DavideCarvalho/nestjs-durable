import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextAccessor, TenantFilter, TenantLevel, TenantRef } from './context-accessor';
import { Workflow } from './decorators';
import { DurableStartClient } from './durable-start-client';
import { ProxyRunGateway } from './proxy-run-gateway';
import {
  buildEngineTenancy,
  inDurableWork,
  readTenancy,
  stepTenantWrapper,
  tenancySlot,
  tenantFilterNow,
  tenantLabels,
} from './tenancy';

/**
 * Durable against the nestjs-context 2.1 tenancy contract (nested chains, families, `required`,
 * labels, the versioned tenancy slot), through a stand-in accessor that behaves like the context's:
 * `kinds` picks the most specific matching level of the chain, `required` throws with no tenant
 * inside a request, and no request reads as `system`.
 */

class TenantRequiredError extends Error {}

interface Scope {
  tenant?: TenantRef | undefined;
  families?: Record<string, TenantRef> | undefined;
}
const als = new AsyncLocalStorage<Scope>();
const calls: Array<Record<string, unknown> | undefined> = [];
let required = false;

const clinic = { id: 'clinic_1', kind: 'clinic' };
const unit = { id: 'unit_7', kind: 'unit' };
const nested: TenantRef = { ...unit, source: 'app', chain: [clinic, unit] };

function accessor(): ContextAccessor {
  return {
    traceId: () => undefined,
    tenantId: () => als.getStore()?.tenant?.id,
    userRef: () => undefined,
    get: () => undefined,
    tenancy: () => ({ enabled: true, required }),
    tenantFilter: (options) => {
      calls.push(options);
      const scope = als.getStore();
      if (!scope) return { mode: 'system' };
      const ref = options?.family ? scope.families?.[options.family] : scope.tenant;
      if (!ref) {
        if (options?.required ?? required) throw new TenantRequiredError('tenant required');
        return { mode: 'tenantless' };
      }
      const chain = ref.chain ?? [ref];
      const level = options?.kinds
        ? [...chain].reverse().find((l) => options.kinds?.includes(l.kind))
        : ref;
      if (!level) return { mode: 'tenantless' };
      const at = chain.findIndex((l) => l.id === level.id);
      return {
        mode: 'tenant',
        tenant: { ...level, source: ref.source },
        chain: chain.slice(0, at + 1),
      } as TenantFilter;
    },
    tenantLabels: async (tenants: TenantLevel[]) =>
      Object.fromEntries(tenants.map((t) => [t.id, `Label ${t.id}`])),
  };
}

const TENANCY_SLOT = Symbol.for('@dudousxd/nestjs-context:tenancy');
const ACCESSOR_SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');
const holder = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete holder[TENANCY_SLOT];
  delete holder[ACCESSOR_SLOT];
  calls.length = 0;
  required = false;
});

describe('the tenancy option reaches the context', () => {
  it('forwards kinds, family and required to tenantFilter', () => {
    const t = readTenancy({ kinds: ['clinic'], family: 'account', required: true }, accessor());
    expect(t.enabled).toBe(true);
    als.run({ families: { account: { id: 'acc_1', kind: 'account', source: 'app' } } }, () =>
      t.enabled ? t.filter() : undefined,
    );
    expect(calls).toEqual([{ kinds: ['clinic'], family: 'account', required: true }]);
  });

  it('stamps and filters by the configured level of a nested tenant', () => {
    const tenancy = buildEngineTenancy({ kinds: ['clinic'] }, accessor(), {
      withTenant: (_t, fn) => fn(),
    });
    als.run({ tenant: nested }, () => {
      expect(tenancy?.current()).toEqual({ id: 'clinic_1', kind: 'clinic' });
      expect(tenancy?.filter()).toEqual({
        mode: 'tenant',
        tenantId: 'clinic_1',
        nullRows: 'tenantless',
      });
    });
    // Without `kinds`, the most specific level (the tenant itself).
    als.run({ tenant: nested }, () =>
      expect(tenantFilterNow('inherit', accessor())).toMatchObject({ tenantId: 'unit_7' }),
    );
  });
});

describe('required', () => {
  it('throws for a request with no tenant, but never inside durable work', () => {
    const tenancy = buildEngineTenancy({ required: true }, accessor(), {
      withTenant: (_t, fn) => fn(),
    });
    als.run({}, () => {
      expect(() => tenancy?.filter()).toThrow(TenantRequiredError);
      expect(() => tenancy?.current()).toThrow(TenantRequiredError);
      expect(tenancy?.system?.(() => tenancy.filter())).toEqual({ mode: 'tenantless' });
      expect(inDurableWork(() => tenancy?.current())).toBeUndefined();
    });
    // No request at all (pollers, recovery): system, never a throw.
    expect(tenancy?.filter()).toEqual({ mode: 'system' });
  });

  it('follows the context default when durable sets none', () => {
    required = true;
    als.run({}, () => expect(() => tenantFilterNow('inherit', accessor())).toThrow());
    als.run({}, () =>
      expect(tenantFilterNow({ required: false }, accessor())).toEqual({ mode: 'tenantless' }),
    );
  });

  it('a worker step with no tenant on its task runs without tripping it', async () => {
    required = true;
    const wrap = stepTenantWrapper('inherit', accessor(), { withTenant: (_t, fn) => fn() });
    const seen = await als.run({}, () =>
      wrap({ unit: 'step', context: {} }, async () => tenantFilterNow('inherit', accessor())),
    );
    expect(seen).toEqual({ mode: 'tenantless' });
  });
});

describe('restoring a run’s tenant', () => {
  it('uses the context’s tenancy slot when it is published, with the configured family', () => {
    const withTenant = vi.fn((_input: unknown, fn: () => unknown) => fn());
    holder[TENANCY_SLOT] = { version: 1, withTenant };
    const runtime = { withTenant: vi.fn((_t: unknown, fn: () => unknown) => fn()) };
    const tenancy = buildEngineTenancy({ family: 'account' }, accessor(), runtime);
    expect(tenancy?.run({ id: 'acc_1', kind: 'account' }, () => 'done')).toBe('done');
    expect(withTenant).toHaveBeenCalledWith(
      { id: 'acc_1', kind: 'account', source: 'carrier' },
      expect.any(Function),
      { family: 'account' },
    );
    expect(runtime.withTenant).not.toHaveBeenCalled();
  });

  it('falls back to the runtime Context without the slot, and ignores another slot version', () => {
    holder[TENANCY_SLOT] = { version: 2, withTenant: () => undefined };
    expect(tenancySlot()).toBeUndefined();
    const runtime = { withTenant: vi.fn((_t: unknown, fn: () => unknown) => fn()) };
    buildEngineTenancy('inherit', accessor(), runtime)?.run({ id: 'o', kind: 'org' }, () => 1);
    expect(runtime.withTenant).toHaveBeenCalledWith(
      { id: 'o', kind: 'org', source: 'carrier' },
      expect.any(Function),
    );
  });

  it('is off when neither the slot nor a runtime can restore a tenant', () => {
    expect(buildEngineTenancy('inherit', accessor(), undefined)).toBeUndefined();
    holder[TENANCY_SLOT] = { version: 1, withTenant: (_t: unknown, fn: () => unknown) => fn() };
    expect(buildEngineTenancy('inherit', accessor(), undefined)).toBeDefined();
  });
});

describe('labels', () => {
  it('come from the context’s resolver, else the slug, else the id', async () => {
    expect(await tenantLabels([{ id: 'o1', kind: 'org' }], accessor())).toEqual({
      o1: 'Label o1',
    });
    expect(
      await tenantLabels([
        { id: 'o1', kind: 'org', slug: 'acme' },
        { id: 'o2', kind: 'org' },
      ]),
    ).toEqual({ o1: 'acme', o2: 'o2' });
  });
});

describe('a tenant process (A4 and narrowing)', () => {
  @Workflow({ name: 'demo', version: '1' })
  class Demo {
    run() {
      return null;
    }
  }

  function queue(sink: unknown[]) {
    return class {
      async add(_name: string, data: unknown) {
        sink.push(data);
      }
      async close() {}
    };
  }

  it('claims the request’s customer tenant on a start, or an explicit one, or none', async () => {
    const sink: Array<Record<string, unknown>> = [];
    const client = new DurableStartClient(
      { connection: 'redis://x', partition: 'acme' },
      { Queue: queue(sink) },
      accessor(),
    );
    await als.run({ tenant: { id: 'org_1', kind: 'organization', source: 'app' } }, () =>
      client.start(Demo, {}, 'r1'),
    );
    await client.start(Demo, {}, 'r2', { tenantId: 'org_9', tenantKind: 'organization' });
    await als.run({ tenant: { id: 'org_1', kind: 'organization', source: 'app' } }, () =>
      client.start(Demo, {}, 'r3', { tenantId: null }),
    );
    expect(sink[0]).toMatchObject({
      tenant: 'acme',
      tenantId: 'org_1',
      tenantKind: 'organization',
    });
    expect(sink[1]).toMatchObject({ tenantId: 'org_9', tenantKind: 'organization' });
    expect(sink[2]).not.toHaveProperty('tenantId');
  });

  function transport() {
    let onReply: (reply: { requestId: string; result: unknown }) => void = () => {};
    const requests: Array<{ requestId: string; body: { kind: string; query?: unknown } }> = [];
    let answer: (body: { kind: string }) => unknown = () => null;
    return {
      onRunReply: (h: typeof onReply) => {
        onReply = h;
      },
      dispatchRunRequest: async (msg: (typeof requests)[number]) => {
        requests.push(msg);
        queueMicrotask(() =>
          onReply({ requestId: msg.requestId, result: { ok: true, data: answer(msg.body) } }),
        );
      },
      answering(fn: typeof answer) {
        answer = fn;
      },
      requests,
    };
  }

  it('narrows the proxy’s reads and control calls to the request’s tenant', async () => {
    const tx = transport();
    const gw = new ProxyRunGateway(tx as never, 'acme', 5000, undefined, undefined, () =>
      tenantFilterNow('inherit', accessor()),
    );
    const runs: Record<string, { id: string; tenantId: string | null }> = {
      mine: { id: 'mine', tenantId: 'org_1' },
      theirs: { id: 'theirs', tenantId: 'org_2' },
    };
    tx.answering((body) => {
      const b = body as { kind: string; runId?: string };
      if (b.kind === 'getRun') return runs[b.runId as string] ?? null;
      if (b.kind === 'listRuns') return [];
      if (b.kind === 'cancel') return { runId: b.runId, status: 'cancelled' };
      return null;
    });
    await als.run({ tenant: { id: 'org_1', kind: 'organization', source: 'app' } }, async () => {
      await gw.listRuns({ workflow: 'w' });
      expect(tx.requests.at(-1)?.body.query).toEqual({ workflow: 'w', tenantIds: ['org_1'] });
      expect(await gw.getRun('mine')).toMatchObject({ id: 'mine' });
      expect(await gw.getRun('theirs')).toBeNull();
      expect(await gw.cancel('theirs')).toBeNull();
      expect(tx.requests.some((r) => r.body.kind === 'cancel')).toBe(false);
      expect(await gw.cancel('mine')).toMatchObject({ status: 'cancelled' });
    });
    // A tenant-required request with no tenant rejects every call, never throws synchronously.
    required = true;
    await als.run({}, async () => {
      for (const call of [
        () => gw.listRuns({}),
        () => gw.runFacets({}),
        () => gw.runValueFacets({ field: 'workflow' }, {}),
        () => gw.cancel('mine'),
        () => gw.getRun('mine'),
      ]) {
        let result: Promise<unknown> | undefined;
        expect(() => {
          result = call();
        }).not.toThrow();
        await expect(result).rejects.toBeInstanceOf(TenantRequiredError);
      }
    });
    required = false;
    // Outside a request (a script, the operator's own work): nothing is narrowed.
    await gw.listRuns({ workflow: 'w' });
    expect(tx.requests.at(-1)?.body.query).toEqual({ workflow: 'w' });
  });
});
