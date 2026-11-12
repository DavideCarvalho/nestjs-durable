import { AsyncLocalStorage } from 'node:async_hooks';
import {
  InMemoryStateStore,
  type RemoteTask,
  RunGateway,
  type StepResult,
  type Transport,
  type WorkflowCtx,
  WorkflowEngine,
  clearDurableExecutionWrappers,
  hasDurableExecutionWrappers,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextAccessor, TenantFilter, TenantRef } from './context-accessor';
import { Workflow } from './decorators';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { buildEngineTenancy, readTenancy, tenantFromCarrier } from './tenancy';
import { CONTEXT_ACCESSOR } from './tokens';
import { WorkflowService } from './workflow.service';

/**
 * An ALS-backed stand-in for `@dudousxd/nestjs-context` ≥ 1.2 (its `Context` runtime and its
 * accessor), so the spec exercises the real wiring without the separate-repo package.
 */
interface Store {
  tenant?: TenantRef | undefined;
  tenantId?: string | undefined;
  all?: boolean | undefined;
}
const als = new AsyncLocalStorage<Store>();
let enabled = true;
const Context = {
  deserialize<T>(carrier: Record<string, unknown>, fn: () => T): T {
    return als.run({ tenant: carrier.tenant as TenantRef | undefined }, fn);
  },
  withTenant<T>(input: { id: string; kind: string; source?: string } | null, fn: () => T): T {
    const tenant = input
      ? { id: input.id, kind: input.kind, source: input.source ?? 'app' }
      : undefined;
    return als.run({ tenant, tenantId: tenant?.id }, fn);
  },
  tenant: () => als.getStore()?.tenant,
};
vi.mock('@dudousxd/nestjs-context', () => ({ Context }));

function contextAccessor(): ContextAccessor {
  return {
    traceId: () => undefined,
    tenantId: () => als.getStore()?.tenant?.id,
    userRef: () => undefined,
    get: () => undefined,
    tenant: () => als.getStore()?.tenant,
    tenancy: () => ({ enabled }),
    tenantFilter: (options?: { kinds?: string[] }): TenantFilter => {
      const store = als.getStore();
      if (!store) return { mode: 'system' };
      if (store.all) return { mode: 'all' };
      const t = store.tenant;
      if (t && (!options?.kinds || options.kinds.includes(t.kind))) {
        return { mode: 'tenant', tenant: t };
      }
      return { mode: 'tenantless' };
    },
  };
}
const asTenant = <T>(id: string, fn: () => T, kind = 'organization'): T =>
  als.run({ tenant: { id, kind, source: 'app' } }, fn);

let seen: (string | undefined)[] = [];

@Workflow({ name: 'wf', version: '1' })
class Wf {
  async run(ctx: WorkflowCtx) {
    seen.push(Context.tenant()?.id);
    await ctx.waitForSignal(`go:${ctx.runId}`);
    seen.push(Context.tenant()?.id);
    await ctx.step('ext.ping', {});
    return Context.tenant()?.id ?? 'none';
  }
}

/** Captures each dispatched task and completes it. */
function recordingTransport(dispatched: RemoteTask[]): Transport {
  let onResult: ((r: StepResult) => Promise<void>) | undefined;
  return {
    async dispatch(task) {
      dispatched.push(task);
      const { runId, seq, stepId } = task;
      setImmediate(() => void onResult?.({ runId, seq, stepId, status: 'completed', output: 1 }));
    },
    onResult(handler) {
      onResult = handler;
    },
    onHeartbeat() {},
  };
}

async function build(options: Partial<DurableModuleOptions> = {}) {
  const store = new InMemoryStateStore();
  const dispatched: RemoteTask[] = [];
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({ store, transport: recordingTransport(dispatched), ...options }),
    ],
    providers: [Wf, { provide: CONTEXT_ACCESSOR, useValue: contextAccessor() }],
  }).compile();
  await moduleRef.init();
  return {
    store,
    dispatched,
    service: moduleRef.get(WorkflowService),
    engine: moduleRef.get(WorkflowEngine),
    gateway: moduleRef.get(RunGateway),
    close: () => moduleRef.close(),
  };
}

async function settled(store: InMemoryStateStore, runId: string, status: string) {
  for (let i = 0; i < 200; i += 1) {
    if ((await store.getRun(runId))?.status === status) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`run ${runId} never reached ${status}`);
}

afterEach(() => {
  enabled = true;
  seen = [];
  clearDurableExecutionWrappers();
});

describe('readTenancy (the local structural reader)', () => {
  const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');
  const g = globalThis as unknown as Record<symbol, unknown>;

  it('is off with no context, with an older accessor, or with tenancy: false', () => {
    expect(readTenancy('inherit', undefined).enabled).toBe(false);
    const old: ContextAccessor = {
      traceId: () => undefined,
      tenantId: () => 'acme',
      userRef: () => undefined,
      get: () => undefined,
    };
    expect(readTenancy('inherit', old).enabled).toBe(false);
    expect(readTenancy(false, contextAccessor()).enabled).toBe(false);
  });

  it("'inherit' follows the context switch; an explicit enabled wins", () => {
    enabled = false;
    expect(readTenancy('inherit', contextAccessor()).enabled).toBe(false);
    expect(readTenancy({ enabled: true }, contextAccessor()).enabled).toBe(true);
    enabled = true;
    expect(readTenancy(undefined, contextAccessor()).enabled).toBe(true);
    expect(readTenancy({ enabled: false }, contextAccessor()).enabled).toBe(false);
  });

  it('reads the global slot when no accessor is bound', () => {
    const before = g[SLOT];
    g[SLOT] = { current: contextAccessor() };
    try {
      expect(readTenancy('inherit', undefined).enabled).toBe(true);
    } finally {
      g[SLOT] = before;
    }
  });

  it('maps the context filter for the engine: kinds, nullRows, and the four modes', () => {
    const t = buildEngineTenancy(
      { kinds: ['organization'], nullRows: 'shared' },
      contextAccessor(),
      Context,
    );
    expect(t?.filter()).toEqual({ mode: 'system' });
    expect(asTenant('acme', () => t?.filter())).toEqual({
      mode: 'tenant',
      tenantId: 'acme',
      nullRows: 'shared',
    });
    expect(asTenant('acme', () => t?.current())).toEqual({ id: 'acme', kind: 'organization' });
    // A tenant of a kind outside `kinds` counts as no tenant: nothing stamped, tenantless reads.
    expect(asTenant('u1', () => t?.filter(), 'user')).toEqual({ mode: 'tenantless' });
    expect(asTenant('u1', () => t?.current(), 'user')).toBeUndefined();
    expect(als.run({ all: true }, () => t?.filter())).toEqual({ mode: 'all' });
    expect(buildEngineTenancy(false, contextAccessor(), Context)).toBeUndefined();
    expect(buildEngineTenancy('inherit', contextAccessor(), undefined)).toBeUndefined();
  });

  it('reads a tenant off a carrier (full ref, else a plain tenantId)', () => {
    expect(tenantFromCarrier({ tenant: { id: 'a', kind: 'clinic' }, tenantId: 'a' })).toEqual({
      id: 'a',
      kind: 'clinic',
    });
    expect(tenantFromCarrier({ tenantId: 'b' })).toEqual({ id: 'b' });
    expect(tenantFromCarrier({})).toBeUndefined();
    expect(tenantFromCarrier(undefined)).toBeUndefined();
  });
});

describe('DurableModule with tenancy on', () => {
  it('stamps the request tenant and restores it on a signal resume from no request', async () => {
    const { store, service, engine, dispatched, close } = await build();
    await asTenant('acme', () => service.start('wf', {}, 'r1'));
    await settled(store, 'r1', 'suspended');
    expect(await store.getRun('r1')).toMatchObject({
      tenantId: 'acme',
      tenantKind: 'organization',
    });

    await engine.signal('go:r1', 1); // e.g. a webhook worker: no context
    await settled(store, 'r1', 'completed');
    expect(seen.every((t) => t === 'acme')).toBe(true);
    expect((await store.getRun('r1'))?.output).toBe('acme');
    // The dispatched task carries the full tenant, kind included (not only `tenantId`).
    expect(dispatched[0]?.context).toMatchObject({
      tenantId: 'acme',
      tenant: { id: 'acme', kind: 'organization' },
    });
    await close();
  });

  it('scopes the dashboard gateway and control calls to the request tenant (404, not 403)', async () => {
    const { store, service, gateway, close } = await build();
    await asTenant('acme', () => service.start('wf', {}, 'a'));
    await asTenant('globex', () => service.start('wf', {}, 'g'));
    await settled(store, 'a', 'suspended');
    await settled(store, 'g', 'suspended');

    const ids = async () => (await gateway.listRuns({})).map((r) => r.id).sort();
    expect(await asTenant('acme', ids)).toEqual(['a']);
    expect(await asTenant('globex', ids)).toEqual(['g']);
    expect(await ids()).toEqual(['a', 'g']); // system (no request): unfiltered
    expect(await asTenant('acme', () => gateway.getRunDetail('g'))).toBeNull();
    expect(await asTenant('acme', () => gateway.getRun('g'))).toBeNull();
    expect(await asTenant('acme', () => gateway.cancel('g'))).toBeNull();
    expect((await store.getRun('g'))?.status).toBe('suspended');
    const facets = await asTenant('acme', () => gateway.runFacets({}));
    expect(facets.reduce((n, f) => n + f.count, 0)).toBe(1);
    await close();
  });

  it("waitForRun and the run event stream tell a tenant nothing about another tenant's run", async () => {
    const { store, service, gateway, close } = await build();
    await asTenant('acme', () => service.start('wf', {}, 'a'));
    await settled(store, 'a', 'suspended');
    await expect(asTenant('globex', () => service.waitForRun('a'))).rejects.toThrow(
      'run a not found',
    );
    expect((await asTenant('acme', () => service.waitForRun('a'))).status).toBe('suspended');

    const acmeSaw: string[] = [];
    const globexSaw: string[] = [];
    const offAcme = asTenant('acme', () => gateway.subscribe('a', (e) => acmeSaw.push(e.type)));
    const offGlobex = asTenant('globex', () =>
      gateway.subscribe('a', (e) => globexSaw.push(e.type)),
    );
    // Events of a run that does not exist yet are held until its row says whose it is.
    const lateSaw: string[] = [];
    const offLate = asTenant('globex', () =>
      gateway.subscribe('late', (e) => lateSaw.push(e.type)),
    );
    const ownLateSaw: string[] = [];
    const offOwnLate = asTenant('acme', () =>
      gateway.subscribe('late', (e) => ownLateSaw.push(e.type)),
    );
    await service.signal('go:a', 1); // from no request
    await settled(store, 'a', 'completed');
    await asTenant('acme', () => service.start('wf', {}, 'late'));
    await settled(store, 'late', 'suspended');
    await new Promise((r) => setTimeout(r, 20));
    expect(acmeSaw).toContain('run.completed');
    expect(globexSaw).toEqual([]);
    expect(lateSaw).toEqual([]);
    expect(ownLateSaw).toContain('run.suspended');
    offOwnLate();
    offAcme();
    offGlobex();
    offLate();
    await close();
  });

  it('restores the carried tenant around a dispatched step handler on any transport', async () => {
    const { close } = await build();
    expect(hasDurableExecutionWrappers()).toBe(true);
    const task: RemoteTask = {
      runId: 'r',
      seq: 0,
      name: 'charge',
      stepId: 'r:0',
      group: 'charge',
      input: {},
      attempt: 1,
      context: { tenantId: 'acme', tenant: { id: 'acme', kind: 'organization' } },
    };
    const result = await runStepHandler(task, async () => Context.tenant());
    expect(result.output).toMatchObject({ id: 'acme', kind: 'organization', source: 'carrier' });
    await close();
  });
});

describe('DurableModule with tenancy off', () => {
  it('registers nothing, stamps nothing and filters nothing', async () => {
    enabled = false;
    const { store, service, gateway, close } = await build();
    expect(hasDurableExecutionWrappers()).toBe(false);
    await asTenant('acme', () => service.start('wf', {}, 'a'));
    await settled(store, 'a', 'suspended');
    expect('tenantId' in ((await store.getRun('a')) ?? {})).toBe(false);
    expect((await asTenant('globex', () => gateway.listRuns({}))).map((r) => r.id)).toEqual(['a']);
    await close();
  });

  it('tenancy: false opts durable out even when the context enables tenancy', async () => {
    const { store, service, close } = await build({ tenancy: false });
    expect(hasDurableExecutionWrappers()).toBe(false);
    await asTenant('acme', () => service.start('wf', {}, 'a'));
    await settled(store, 'a', 'suspended');
    expect((await store.getRun('a'))?.tenantId ?? null).toBeNull();
    await close();
  });
});
