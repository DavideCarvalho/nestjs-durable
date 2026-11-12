import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { accumulatorRunId } from './event-accumulators';
import type { RemoteTask, WorkflowRun } from './interfaces';
import { LIFECYCLE_PENDING_TAG, runCompletedEvent } from './lifecycle-events';
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
    // A start for another tenant (or none) is not the caller's to wait on: wait outside the request.
    await asTenant('acme', () => engine.start('wf', {}, 'explicit', { tenantId: 'globex' }));
    await asTenant('acme', () => engine.start('wf', {}, 'none', { tenantId: null }));
    await engine.waitForRun('explicit');
    await engine.waitForRun('none');
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
  it("runs every turn, with or without a tenant, inside the host's system scope", async () => {
    const work = new AsyncLocalStorage<true>();
    const inWork: Array<[string | null, boolean]> = [];
    const tenancy: EngineTenancy = {
      ...fakeTenancy(),
      system: (fn) => work.run(true, fn),
    };
    const { engine } = setup({ tenancy });
    engine.register('wf', '1', async () => {
      inWork.push([seenTenant(), work.getStore() === true]);
      return 'ok';
    });
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'with'));
    await tenantless(() => startRun(engine, 'wf', {}, 'without'));
    expect(inWork).toEqual([
      ['acme', true],
      [null, true],
    ]);
  });

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

  it("local steps see the run's tenant even when the app's carrier drops it", async () => {
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({
      store,
      clock: () => now,
      tenancy: fakeTenancy(),
      // An app carrier that keeps only `traceId`: its deserializer replaces the ambient context
      // around every local step with one that has no tenant.
      context: () => ({ traceId: 't-1' }),
      rehydrate: (_carrier, fn) => als.run({}, fn),
    });
    const steps: (string | null)[] = [];
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('start', async () => steps.push(seenTenant()));
      await ctx.sleep('10s');
      await ctx.localStep('timer', async () => steps.push(seenTenant()));
      await ctx.waitForSignal('go');
      await ctx.localStep('signal', async () => steps.push(seenTenant()));
      return 'ok';
    });
    await asTenant('acme', () => startRun(engine, 'wf', {}, 'r1'));
    now = 20_000;
    await engine.resumeDueTimers(20_000); // a poller: no context
    await engine.signal('go', 1); // no request either
    await poll(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(steps).toEqual(['acme', 'acme', 'acme']);
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
  it('a host that requires a tenant rejects the read, it does not throw synchronously', async () => {
    const required = new Error('tenant required');
    const { engine } = setup({
      tenancy: {
        ...fakeTenancy(),
        filter: () => {
          throw required;
        },
      },
    });
    const read = engine.getRun('r1');
    expect(read).toBeInstanceOf(Promise);
    await expect(read).rejects.toBe(required);
  });

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

describe('tenancy on: waiting and lookups learn nothing about another tenant', () => {
  async function seeded() {
    const env = setup({ tenancy: fakeTenancy() });
    env.engine.register('done', '1', async () => ({ secret: 'acme-output' }));
    env.engine.register('wf', '1', async (ctx) => ctx.waitForSignal(`go:${ctx.runId}`));
    await asTenant('acme', () => startRun(env.engine, 'done', {}, 'a'));
    return env;
  }

  it("waitForRun rejects 'not found' for another tenant's run, and resolves for its own", async () => {
    const { engine } = await seeded();
    await expect(asTenant('globex', () => engine.waitForRun('a'))).rejects.toThrow(
      'run a not found',
    );
    await expect(tenantless(() => engine.waitForRun('a'))).rejects.toThrow('run a not found');
    expect(await asTenant('acme', () => engine.waitForRun('a'))).toMatchObject({
      status: 'completed',
      output: { secret: 'acme-output' },
    });
    expect((await allTenants(() => engine.waitForRun('a'))).status).toBe('completed');
  });

  it('waitForRun keeps waiting for a missing run, then rejects if another tenant creates it', async () => {
    const { engine } = await seeded();
    const own = asTenant('acme', () => engine.waitForRun('later-own', { timeoutMs: 2_000 }));
    const foreign = asTenant('globex', () =>
      engine.waitForRun('later-foreign', { timeoutMs: 2_000 }),
    );
    const foreignOutcome = foreign.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await asTenant('acme', () => engine.start('done', {}, 'later-own'));
    await asTenant('acme', () => engine.start('done', {}, 'later-foreign'));
    expect((await own).output).toEqual({ secret: 'acme-output' });
    expect(await foreignOutcome).toBe('run later-foreign not found');
  });

  it('start with the id of an existing run of another tenant returns no output or error', async () => {
    const { engine } = await seeded();
    const result = await asTenant('globex', () => engine.start('done', {}, 'a'));
    expect(result).toEqual({ runId: 'a', status: 'completed' });
    expect((await asTenant('acme', () => engine.start('done', {}, 'a'))).output).toEqual({
      secret: 'acme-output',
    });
  });

  it('getRunChildren and triggeredRuns are empty for a parent the caller may not see', async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    engine.register('child', '1', async () => 2);
    engine.register('parent', '1', async (ctx) => ctx.child('child', {}));
    await asTenant('acme', () => startRun(engine, 'parent', {}, 'p1'));
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    await store.updateRun('p1', { tags: ['durable:triggered:sub'] });
    expect(await asTenant('acme', () => engine.getRunChildren('p1'))).toHaveLength(1);
    expect(await asTenant('acme', () => engine.triggeredRuns('p1'))).toHaveLength(1);
    expect(await asTenant('globex', () => engine.getRunChildren('p1'))).toEqual([]);
    expect(await asTenant('globex', () => engine.triggeredRuns('p1'))).toEqual([]);
    const run = (await store.getRun('p1')) as WorkflowRun;
    expect(await tenantless(() => engine.triggeredRuns(run))).toEqual([]);
    // Deleting the parent still removes its whole subtree.
    expect(await asTenant('acme', () => engine.deleteRun('p1'))).toBe(2);
  });
});

describe('tenancy on: named events are per tenant', () => {
  async function waiting(nullRows?: 'shared') {
    const env = setup({ tenancy: fakeTenancy(nullRows ? { nullRows } : {}) });
    env.engine.register('listener', '1', async (ctx) => ctx.waitForEvent('price', {}));
    await asTenant('acme', () => startRun(env.engine, 'listener', {}, 'a'));
    await asTenant('globex', () => startRun(env.engine, 'listener', {}, 'g'));
    await tenantless(() => startRun(env.engine, 'listener', {}, 'n'));
    return env;
  }
  const settled = async (store: InMemoryStateStore) =>
    (
      await Promise.all(
        ['a', 'g', 'n'].map(async (id) => {
          const run = await store.getRun(id);
          return run?.status === 'completed' ? `${id}=${JSON.stringify(run.output)}` : undefined;
        }),
      )
    ).filter(Boolean);

  it("a tenant's publish resumes only its own waiters", async () => {
    const { engine, store } = await waiting();
    expect(await asTenant('acme', () => engine.publishEvent('price', 1))).toBe(1);
    await poll(async () => (await settled(store)).length === 1);
    expect(await settled(store)).toEqual(['a=1']);
  });

  it('a tenantless publish resumes only runs with no tenant', async () => {
    const { engine, store } = await waiting();
    expect(await tenantless(() => engine.publishEvent('price', 2))).toBe(1);
    await poll(async () => (await settled(store)).length === 1);
    expect(await settled(store)).toEqual(['n=2']);
  });

  it("nullRows: 'shared' lets a tenant's publish also reach runs with no tenant", async () => {
    const { engine, store } = await waiting('shared');
    expect(await asTenant('acme', () => engine.publishEvent('price', 3))).toBe(2);
    await poll(async () => (await settled(store)).length === 2);
    expect(await settled(store)).toEqual(['a=3', 'n=3']);
  });

  it('an all-tenants or system publish stays global', async () => {
    const { engine, store } = await waiting();
    expect(await allTenants(() => engine.publishEvent('price', 4))).toBe(3);
    await poll(async () => (await settled(store)).length === 3);
    const other = await waiting();
    expect(await other.engine.publishEvent('price', 5)).toBe(3);
    await poll(async () => (await settled(other.store)).length === 3);
  });

  it("a buffered event is consumed only by a run its publisher's tenant may see", async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    engine.register('listener', '1', async (ctx) => ctx.waitForEvent('price', {}));
    expect(await asTenant('acme', () => engine.publishEvent('price', 7))).toBe(0); // buffered
    await asTenant('globex', () => startRun(engine, 'listener', {}, 'g'));
    await tenantless(() => startRun(engine, 'listener', {}, 'n'));
    expect((await store.getRun('g'))?.status).toBe('suspended');
    expect((await store.getRun('n'))?.status).toBe('suspended');
    await asTenant('acme', () => startRun(engine, 'listener', {}, 'a'));
    const a = (await store.getRun('a')) as WorkflowRun;
    expect([a.status, a.output]).toEqual(['completed', 7]);
    expect(await store.listBufferedEvents('price', 10)).toEqual([]);
  });

  it('a tenant publish with no visible waiter buffers instead of waking another tenant', async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    engine.register('listener', '1', async (ctx) => ctx.waitForEvent('price', {}));
    await asTenant('globex', () => startRun(engine, 'listener', {}, 'g'));
    expect(await asTenant('acme', () => engine.publishEvent('price', 8))).toBe(0);
    expect((await store.getRun('g'))?.status).toBe('suspended');
    expect(await store.listBufferedEvents('price', 10)).toHaveLength(1);
    // globex's own publish reaches it.
    expect(await asTenant('globex', () => engine.publishEvent('price', 9))).toBe(1);
    await poll(async () => (await store.getRun('g'))?.status === 'completed');
    expect((await store.getRun('g'))?.output).toBe(9);
  });
});

describe('tenancy off: named events', () => {
  it('fan out to every waiter and buffer the payload as is', async () => {
    const { engine, store } = setup();
    engine.register('listener', '1', async (ctx) => ctx.waitForEvent('price', {}));
    await asTenant('acme', () => startRun(engine, 'listener', {}, 'a'));
    await asTenant('globex', () => startRun(engine, 'listener', {}, 'g'));
    expect(await asTenant('acme', () => engine.publishEvent('price', 1))).toBe(2);
    expect(await asTenant('acme', () => engine.publishEvent('price', 2))).toBe(0);
    expect((await store.listBufferedEvents('price', 10)).map((e) => e.payload)).toEqual([2]);
    await asTenant('globex', () => startRun(engine, 'listener', {}, 'g2'));
    expect((await store.getRun('g2'))?.output).toBe(2);
  });
});

describe('eventBatch: one batch run per tenant', () => {
  /** A batched subscriber that records each batch it fires with and the tenant its run sees. */
  function batching(
    opts: { tenancy?: boolean; key?: boolean; on?: string; nullRows?: 'shared' } = {},
  ) {
    const env = setup(
      opts.tenancy === false
        ? {}
        : { tenancy: fakeTenancy(opts.nullRows ? { nullRows: opts.nullRows } : {}) },
    );
    const fired: { tenant: string | null; events: unknown[] }[] = [];
    env.engine.register(
      'agg',
      '1',
      async (_ctx, input) => {
        fired.push({ tenant: seenTenant(), events: (input as { events: unknown[] }).events });
      },
      {
        onEvent: [opts.on ?? 'hit'],
        eventBatch: {
          mode: 'batch',
          maxSize: 2,
          windowMs: 60_000,
          ...(opts.key ? { key: (input: unknown) => (input as { k: string }).k } : {}),
        },
      },
    );
    const batchRuns = async () =>
      (await env.store.listRuns({ workflow: '__evt_batch' })).map((r) => [r.id, r.tenantId]);
    return { ...env, fired, batchRuns };
  }
  const sorted = (fired: { tenant: string | null; events: unknown[] }[]) =>
    [...fired].sort((a, b) => String(a.tenant).localeCompare(String(b.tenant)));

  it("never mixes two tenants' events, and each batch run carries its tenant", async () => {
    const { engine, store, fired, batchRuns } = batching();
    await asTenant('acme', () => engine.publishEvent('hit', { n: 1 }));
    await asTenant('globex', () => engine.publishEvent('hit', { n: 2 }));
    await asTenant('acme', () => engine.publishEvent('hit', { n: 3 }));
    await asTenant('globex', () => engine.publishEvent('hit', { n: 4 }));
    await poll(async () => fired.length === 2);
    expect(sorted(fired)).toEqual([
      { tenant: 'acme', events: [{ n: 1 }, { n: 3 }] },
      { tenant: 'globex', events: [{ n: 2 }, { n: 4 }] },
    ]);
    const acme = await store.getRun(accumulatorRunId('agg', undefined, 'acme'));
    const globex = await store.getRun(accumulatorRunId('agg', undefined, 'globex'));
    expect([acme?.tenantId, acme?.tenantKind]).toEqual(['acme', 'organization']);
    expect(globex?.tenantId).toBe('globex');
    expect(await store.getRun(accumulatorRunId('agg'))).toBeNull();
    for (const [, tenantId] of await batchRuns()) expect(['acme', 'globex']).toContain(tenantId);
    // The fired target runs carry the tenant too.
    const targets = await store.listRuns({ workflow: 'agg' });
    expect(targets.map((r) => r.tenantId).sort()).toEqual(['acme', 'globex']);
  });

  it('keeps per-key batches per tenant too: the same key never shares a run across tenants', async () => {
    const { engine, fired } = batching({ key: true });
    await asTenant('acme', () => engine.publishEvent('hit', { k: 'x', n: 1 }));
    await asTenant('globex', () => engine.publishEvent('hit', { k: 'x', n: 2 }));
    await asTenant('globex', () => engine.publishEvent('hit', { k: 'x', n: 3 }));
    await asTenant('acme', () => engine.publishEvent('hit', { k: 'x', n: 4 }));
    await poll(async () => fired.length === 2);
    expect(sorted(fired)).toEqual([
      {
        tenant: 'acme',
        events: [
          { k: 'x', n: 1 },
          { k: 'x', n: 4 },
        ],
      },
      {
        tenant: 'globex',
        events: [
          { k: 'x', n: 2 },
          { k: 'x', n: 3 },
        ],
      },
    ]);
  });

  it("nullRows: 'shared' still gives each tenant its own batch run", async () => {
    const { engine, fired } = batching({ nullRows: 'shared' });
    await asTenant('acme', () => engine.publishEvent('hit', { n: 1 }));
    await asTenant('globex', () => engine.publishEvent('hit', { n: 2 }));
    await asTenant('acme', () => engine.publishEvent('hit', { n: 3 }));
    await poll(async () => fired.length === 1);
    expect(fired).toEqual([{ tenant: 'acme', events: [{ n: 1 }, { n: 3 }] }]);
  });

  it('system, all-tenants and tenantless publishes share the batch run with no tenant', async () => {
    const { engine, store, fired } = batching();
    await engine.publishEvent('hit', { n: 1 });
    await allTenants(() => engine.publishEvent('hit', { n: 2 }));
    await tenantless(() => engine.publishEvent('hit', { n: 3 }));
    await engine.publishEvent('hit', { n: 4 });
    await poll(async () => fired.length === 2);
    expect(fired).toEqual([
      { tenant: null, events: [{ n: 1 }, { n: 2 }] },
      { tenant: null, events: [{ n: 3 }, { n: 4 }] },
    ]);
    const shared = await store.getRun(accumulatorRunId('agg'));
    expect(shared?.tenantId ?? null).toBe(null);
  });

  it("a run's lifecycle event goes into the batch run of the run's tenant", async () => {
    const { engine, store, fired } = batching({ on: runCompletedEvent('ingest') });
    engine.register('ingest', '1', async () => 'done');
    await asTenant('acme', () => startRun(engine, 'ingest', {}, 'i1'));
    await asTenant('globex', () => startRun(engine, 'ingest', {}, 'i2'));
    await engine.start('ingest', {}, 'i3', { tenantId: 'acme' }); // a system start, for acme
    await poll(async () => fired.length === 1);
    expect(fired[0]?.tenant).toBe('acme');
    expect(fired[0]?.events.map((e) => (e as { runId: string }).runId).sort()).toEqual([
      'i1',
      'i3',
    ]);
    const i2 = (await store.getRun('i2')) as WorkflowRun;
    expect(engine.coalescedSubscribers(i2).get('agg')).toBe(
      accumulatorRunId('agg', undefined, 'globex'),
    );
    await poll(
      async () =>
        (await store.getRun(accumulatorRunId('agg', undefined, 'globex')))?.tenantId === 'globex',
    );
  });
});

describe('tenancy on: lifecycle subscribers', () => {
  it("a subscriber run started by the background retry pass gets the settled run's tenant", async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    const seen: (string | null)[] = [];
    engine.register('refresh', '1', async () => void seen.push(seenTenant()), {
      onEvent: [runCompletedEvent('ingest')],
    });
    // A run that settled for acme, whose process died before it published its lifecycle event.
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG],
      tenantId: 'acme',
      tenantKind: 'organization',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun);

    expect(await engine.sweepLifecycleEvents(60_000)).toBe(1); // the poller: no context
    const id = 'evt:i1:completed:refresh';
    await poll(async () => (await store.getRun(id))?.status === 'completed');
    expect(await store.getRun(id)).toMatchObject({ tenantId: 'acme', tenantKind: 'organization' });
    expect(seen).toEqual(['acme']);
  });

  it('a subscriber of a run with no tenant starts with none, whoever publishes', async () => {
    const { engine, store } = setup({ tenancy: fakeTenancy() });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await engine.start('ingest', {}, 'i1', { tenantId: null });
    const id = 'evt:i1:completed:refresh';
    await poll(async () => (await store.getRun(id))?.status === 'completed');
    expect((await store.getRun(id))?.tenantId ?? null).toBe(null);
  });
});

describe('tenancy off: eventBatch', () => {
  it('keeps one batch run per workflow with no tenant, whoever publishes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const fired: unknown[] = [];
    engine.register('agg', '1', async (_ctx, input) => void fired.push(input), {
      onEvent: ['hit'],
      eventBatch: { mode: 'batch', maxSize: 2, windowMs: 60_000 },
    });
    await asTenant('acme', () => engine.publishEvent('hit', { n: 1 }));
    await asTenant('globex', () => engine.publishEvent('hit', { n: 2 }));
    await poll(async () => fired.length === 1);
    expect(fired).toEqual([{ events: [{ n: 1 }, { n: 2 }] }]);
    const runs = await store.listRuns({ workflow: '__evt_batch' });
    // The batch run and its continue-as-new re-arm.
    expect(runs.map((r) => r.id).sort()).toEqual(['__evtacc__:agg', '__evtacc__:agg~1']);
    expect(runs.every((r) => !('tenantId' in r))).toBe(true);
    expect(accumulatorRunId('agg')).toBe('__evtacc__:agg');
    expect(accumulatorRunId('agg', 'k')).toBe('__evtacc__:agg:k');
  });
});
