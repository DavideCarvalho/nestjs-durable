import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { RemoteTask, WorkflowRun } from './interfaces';
import {
  type EngineTenancy,
  type RunTenant,
  scopeTenantQuery,
  tenantIdsFor,
  tenantVisible,
} from './tenancy';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/** A stand-in for nestjs-context: an ALS holding the request's tenant (or the all-tenants scope). */
interface Scope {
  tenant?: RunTenant | undefined;
  all?: boolean | undefined;
}
const als = new AsyncLocalStorage<Scope>();
const asTenant = <T>(id: string, fn: () => T): T =>
  als.run({ tenant: { id, kind: 'organization' } }, fn);
const tenantless = <T>(fn: () => T): T => als.run({}, fn);
const allTenants = <T>(fn: () => T): T => als.run({ all: true }, fn);
/** The tenant the code running now sees, as a step body would read `Context.tenant()`. */
const seenTenant = (): string | null => als.getStore()?.tenant?.id ?? null;

function fakeTenancy(opts: { nullRows?: 'tenantless' | 'shared' } = {}): EngineTenancy {
  return {
    current: () => {
      const tenant = als.getStore()?.tenant;
      return tenant ? { ...tenant } : undefined;
    },
    filter: () => {
      const scope = als.getStore();
      if (!scope) return { mode: 'system' };
      if (scope.all) return { mode: 'all' };
      if (scope.tenant)
        return { mode: 'tenant', tenantId: scope.tenant.id, nullRows: opts.nullRows };
      return { mode: 'tenantless' };
    },
    run: (tenant, fn) => als.run({ tenant }, fn),
  };
}

function setup(opts: { tenancy?: EngineTenancy | undefined; now?: number } = {}) {
  const store = new InMemoryStateStore();
  let now = opts.now ?? 1_000;
  const engine = new WorkflowEngine({
    store,
    clock: () => now,
    ...(opts.tenancy ? { tenancy: opts.tenancy } : {}),
  });
  return {
    store,
    engine,
    at: (ms: number) => {
      now = ms;
    },
  };
}

async function poll(check: () => Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

describe('tenancy helpers (the matching rule)', () => {
  const acme = { tenantId: 'acme' };
  const other = { tenantId: 'globex' };
  const none = {};
  it.each([
    ['system', { mode: 'system' as const }, [true, true, true]],
    ['all', { mode: 'all' as const }, [true, true, true]],
    ['tenantless', { mode: 'tenantless' as const }, [false, false, true]],
    ['tenant', { mode: 'tenant' as const, tenantId: 'acme' }, [true, false, false]],
    [
      'tenant + shared',
      { mode: 'tenant' as const, tenantId: 'acme', nullRows: 'shared' as const },
      [true, false, true],
    ],
  ])('%s sees [own, other, none] = %j', (_label, filter, expected) => {
    expect([acme, other, none].map((row) => tenantVisible(row, filter))).toEqual(expected);
  });

  it('turns a filter into tenantIds and only ever narrows an existing set', () => {
    expect(tenantIdsFor({ mode: 'system' })).toBeUndefined();
    expect(tenantIdsFor({ mode: 'tenantless' })).toEqual([null]);
    expect(tenantIdsFor({ mode: 'tenant', tenantId: 'a', nullRows: 'shared' })).toEqual([
      'a',
      null,
    ]);
    expect(scopeTenantQuery({ tenantIds: ['a', 'b'] }, { mode: 'tenant', tenantId: 'a' })).toEqual({
      tenantIds: ['a'],
    });
    expect(scopeTenantQuery({ tenantIds: ['b'] }, { mode: 'tenant', tenantId: 'a' })).toEqual({
      tenantIds: [],
    });
    expect(scopeTenantQuery({ limit: 5 }, { mode: 'all' })).toEqual({ limit: 5 });
  });
});

describe('tenancy off', () => {
  it('stamps nothing, filters nothing, and runs turns exactly as before', async () => {
    const { engine, store } = setup();
    const turns: (string | null)[] = [];
    engine.register('wf', '1', async (ctx) => {
      turns.push(seenTenant());
      await ctx.waitForSignal('go');
      turns.push(seenTenant());
      return 'ok';
    });
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'r1'));
    const row = (await store.getRun('r1')) as WorkflowRun;
    expect('tenantId' in row).toBe(false);
    expect('tenantKind' in row).toBe(false);
    // Another tenant's request still reaches it: nothing is filtered with tenancy off.
    expect(await asTenant('globex', () => engine.getRun('r1'))).not.toBeNull();
    await asTenant('globex', () => engine.signal('go', 1));
    await poll(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it('still honours an explicit StartOptions.tenantId', async () => {
    const { engine, store } = setup();
    engine.register('wf', '1', async () => 'ok');
    await startRun(engine, 'wf', {}, 'r1', { tenantId: 'acme', tenantKind: 'organization' });
    expect(await store.getRun('r1')).toMatchObject({
      tenantId: 'acme',
      tenantKind: 'organization',
    });
  });
});

describe('tenancy on: stamping', () => {
  it('stamps the context tenant; an explicit tenantId wins; null starts with none', async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    engine.register('wf', '1', async () => 'ok');
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'ctx'));
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'explicit', { tenantId: 'globex' }));
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'none', { tenantId: null }));
    await tenantless(() => startRun(engine, 'wf', {}, 'orgless'));
    await startRun(engine, 'wf', {}, 'system');
    expect(await store.getRun('ctx')).toMatchObject({
      tenantId: 'acme',
      tenantKind: 'organization',
    });
    expect((await store.getRun('explicit'))?.tenantId).toBe('globex');
    for (const id of ['none', 'orgless', 'system']) {
      expect((await store.getRun(id))?.tenantId ?? null).toBeNull();
    }
  });
});

describe('tenancy on: the tenant is restored on every turn', () => {
  it('survives a timer resume driven outside any request', async () => {
    const { engine, store, at } = setup({ tenancy: fakeTenancy() });
    const turns: (string | null)[] = [];
    engine.register('wf', '1', async (ctx) => {
      turns.push(seenTenant());
      await ctx.sleep('10s');
      turns.push(seenTenant());
      return 'ok';
    });
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'r1'));
    at(20_000);
    await engine.resumeDueTimers(20_000); // a poller: no context at all
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(turns.every((t) => t === 'acme')).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(3);
  });

  it('survives a signal resume, even when the signal comes from an all-tenants admin scope', async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    const turns: (string | null)[] = [];
    engine.register('wf', '1', async (ctx) => {
      const v = await ctx.waitForSignal<number>('approve');
      turns.push(seenTenant());
      return v;
    });
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'r1'));
    await allTenants(() => engine.signal('approve', 7));
    await poll(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(turns).toEqual(['acme']);
  });

  it('survives crash recovery', async () => {
    const NOW = 1_000_000;
    const { engine, store } = setup({ tenancy: fakeTenancy(), now: NOW });
    const turns: (string | null)[] = [];
    engine.register('wf', '1', async () => {
      turns.push(seenTenant());
      return 'ok';
    });
    // A run left `running` by a crashed instance (its lease expired), recovered by a poller.
    await store.createRun({
      id: 'crashed',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      lockedBy: 'dead',
      lockedUntil: NOW - 1,
      tenantId: 'acme',
      tenantKind: 'organization',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await engine.recoverIncomplete(NOW);
    await poll(async () => (await store.getRun('crashed'))?.status === 'completed');
    expect(turns).toEqual(['acme']);
  });

  it('stamps the run tenant on every dispatched step task, also on a turn a poller drove', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const tenancy = fakeTenancy();
    let now = 1_000;
    const engine = new WorkflowEngine({
      store,
      transport,
      clock: () => now,
      tenancy,
      // The context reader the NestJS module wires: reads the ambient context at dispatch.
      context: () => {
        const tenant = als.getStore()?.tenant;
        return tenant ? { tenantId: tenant.id, tenant } : {};
      },
    });
    const tasks: RemoteTask[] = [];
    const dispatch = transport.dispatch.bind(transport);
    transport.dispatch = (task) => {
      tasks.push(task);
      return dispatch(task);
    };
    transport.handle('charge', async () => 'charged');
    engine.register('wf', '1', async (ctx) => {
      await ctx.sleep('1s');
      return ctx.step('charge', {});
    });
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'r1'));
    now = 5_000;
    await engine.resumeDueTimers(5_000);
    await poll(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task.context?.tenantId).toBe('acme');
  });
});

describe('tenancy on: children, continueAsNew and schedules inherit the tenant', () => {
  it('a child run inherits its parent tenant, whoever drives the parent', async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    const childTurns: (string | null)[] = [];
    engine.register('child', '1', async () => {
      childTurns.push(seenTenant());
      return 2;
    });
    engine.register('parent', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return ctx.child('child', {});
    });
    await asTenant('acme', () => startRun(engine, 'parent', {}, 'p1'));
    await engine.signal('go', 1); // from no request at all
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    const children = await engine.getRunChildren('p1');
    expect(children).toHaveLength(1);
    expect((await store.getRun(children[0] as string))?.tenantId).toBe('acme');
    expect(childTurns).toEqual(['acme']);
  });

  it('continueAsNew keeps the tenant, also with no tenant (never picks one up from the driver)', async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    engine.register('counter', '1', async (ctx, input) => {
      const n = (input as { n: number }).n;
      if (n < 2) await ctx.continueAsNew({ n: n + 1 });
      return n;
    });
    await asTenant('acme', () => engine.start('counter', { n: 1 }, 'c1'));
    await poll(async () => (await store.getRun('c1~1'))?.status === 'completed');
    expect((await store.getRun('c1~1'))?.tenantId).toBe('acme');

    await engine.start('counter', { n: 1 }, 'd1', { tenantId: null });
    await poll(async () => (await store.getRun('d1~1'))?.status === 'completed');
    expect((await store.getRun('d1~1'))?.tenantId ?? null).toBeNull();
  });

  it('a schedule keeps the tenant it was created under and every fire inherits it', async () => {
    const T0 = Date.parse('2026-03-02T00:00:00.000Z');
    const { engine, store } = setup({ tenancy: fakeTenancy(), now: T0 });
    engine.register('job', '1', async () => seenTenant());
    const created = await asTenant('acme', () =>
      engine.schedules.create({ id: 'pulse', workflow: 'job', every: '15m' }),
    );
    expect(created.tenantId).toBe('acme');
    const [runId] = await engine.schedules.tick(T0 + 15 * 60_000 + 1); // the poller: no context
    await poll(async () => (await store.getRun(runId as string))?.status === 'completed');
    expect(await store.getRun(runId as string)).toMatchObject({ tenantId: 'acme', output: 'acme' });

    // Reads apply the rule: another tenant cannot see, pause or delete it.
    expect(await asTenant('globex', () => engine.schedules.get('pulse'))).toBeNull();
    expect(await asTenant('globex', () => engine.schedules.list())).toEqual([]);
    expect(await asTenant('globex', () => engine.schedules.delete('pulse'))).toBe(false);
    await expect(asTenant('globex', () => engine.schedules.pause('pulse'))).rejects.toThrow();
    expect((await asTenant('acme', () => engine.schedules.list())).map((s) => s.id)).toEqual([
      'pulse',
    ]);
  });
});

describe('tenancy on: app-facing reads and control apply the matching rule', () => {
  async function seeded(nullRows?: 'shared') {
    const env = setup({ tenancy: fakeTenancy({ nullRows }) });
    env.engine.register('wf', '1', async (ctx) => ctx.waitForSignal(`go:${ctx.runId}`));
    await asTenant('acme', () => startRun(env.engine, 'wf', {}, 'a'));
    await asTenant('globex', () => startRun(env.engine, 'wf', {}, 'g'));
    await tenantless(() => startRun(env.engine, 'wf', {}, 'n'));
    return env;
  }
  const visible = async (engine: WorkflowEngine) =>
    (
      await Promise.all(
        ['a', 'g', 'n'].map(async (id) => ((await engine.getRun(id)) ? id : undefined)),
      )
    ).filter(Boolean);

  it('getRun: tenant sees its own; tenantless sees NULL rows; all/system see everything', async () => {
    const { engine } = await seeded();
    expect(await asTenant('acme', () => visible(engine))).toEqual(['a']);
    expect(await tenantless(() => visible(engine))).toEqual(['n']);
    expect(await allTenants(() => visible(engine))).toEqual(['a', 'g', 'n']);
    expect(await visible(engine)).toEqual(['a', 'g', 'n']);
  });

  it("nullRows: 'shared' lets a tenant also see runs with no tenant", async () => {
    const { engine } = await seeded('shared');
    expect(await asTenant('acme', () => visible(engine))).toEqual(['a', 'n']);
  });

  it('a run of another tenant reads as not found for every control call (never forbidden)', async () => {
    const { engine, store } = await seeded();
    await asTenant('globex', async () => {
      expect(await engine.getRun('a')).toBeNull();
      expect(await engine.listCheckpoints('a')).toEqual([]);
      expect(await engine.signal('go:a', 1)).toBeNull();
      expect(await engine.cancel('a')).toBeNull();
      expect(await engine.requeue('a')).toBeNull();
      expect(await engine.retryWithInput('a', {})).toBeNull();
      expect(await engine.redispatchPending('a')).toBeNull();
      expect(await engine.continue('a')).toBeNull();
      expect(await engine.update('a', 'u', 1)).toEqual({
        accepted: false,
        reason: 'run a not found',
      });
      expect(await engine.deleteRun('a')).toBe(0);
      await expect(engine.resume('a')).rejects.toThrow('run a not found');
    });
    // Nothing above touched it.
    expect((await store.getRun('a'))?.status).toBe('suspended');
    // Its own tenant can.
    expect((await asTenant('acme', () => engine.cancel('a')))?.status).toBe('cancelled');
  });

  it('scopeRunQuery narrows store listings; cancelWhere and purgeRuns stay inside the tenant', async () => {
    const { engine, store } = await seeded();
    const listed = await asTenant('acme', () => store.listRuns(engine.scopeRunQuery({})));
    expect(listed.map((r) => r.id)).toEqual(['a']);
    const cancelled = await asTenant('globex', () => engine.cancelWhere({ workflow: 'wf' }));
    expect(cancelled.map((r) => r.runId)).toEqual(['g']);
    expect(await tenantless(() => engine.purgeRuns({ workflow: 'wf' }))).toBe(1);
    expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'g']);
  });

  it('a retry with a new input keeps the original run tenant', async () => {
    const { engine, store } = await seeded();
    const retried = await asTenant('acme', () => engine.retryWithInput('a', {}));
    expect((await store.getRun(retried?.runId as string))?.tenantId).toBe('acme');
  });
});
