import {
  DURABLE_OPTIONS_CANONICAL,
  InMemoryStateStore,
  STATE_STORE_CANONICAL,
  WorkflowEngine,
  clearDurableExecutionWrappers,
  runTraceId as coreRunTraceId,
} from '@dudousxd/nestjs-durable-core';
import type { ExtensionContext, RecordInput, WatcherContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';
import {
  durableStateProvider,
  durableThroughputProvider,
  durableWorkerHealthProvider,
} from './durable-data-providers';
import { runTraceId } from './durable-run-trace';
import { DurableTelescopeWatcher } from './durable-telescope.watcher';

function ctxFor(
  engine: WorkflowEngine,
  records: RecordInput[],
  options: Record<string, unknown> | undefined,
): WatcherContext {
  const tokens = new Map<unknown, unknown>([
    [WorkflowEngine, engine],
    [DURABLE_OPTIONS_CANONICAL, options],
  ]);
  return {
    record: (input: RecordInput) => records.push(input),
    runInBatch: async (_origin, fn) => fn(),
    beginBatch: () => ({ id: 'b', end: () => {} }),
    config: {} as WatcherContext['config'],
    moduleRef: { get: (token: unknown) => tokens.get(token) } as WatcherContext['moduleRef'],
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function runBoth(engine: WorkflowEngine) {
  engine.register('checkout', '1', async (ctx) => {
    await ctx.localStep('charge', async () => 1);
    return 'ok';
  });
  await engine.start('checkout', {}, 'tenant-run', { namespace: 'acme' });
  await engine.waitForRun('tenant-run');
  await engine.start('checkout', {}, 'own-run');
  await engine.waitForRun('own-run');
  await flush();
}

const of = (records: RecordInput[], runId: string) =>
  records.filter((r) => (r.content as { runId?: string }).runId === runId);

describe('DurableTelescopeWatcher on a control plane', () => {
  afterEach(() => clearDurableExecutionWrappers());

  it("tags every entry of a tenant's run app:<partition>, in the run's trace", async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(ctxFor(engine, records, { topology: 'control-plane' }));

    await runBoth(engine);

    const tenant = of(records, 'tenant-run');
    expect(tenant.map((r) => (r.content as { event: string }).event)).toEqual([
      'run.started',
      'step.started',
      'step.completed',
      'run.completed',
    ]);
    for (const r of tenant) {
      expect(r.tags).toContain('app:acme');
      expect(r.tags).toContain('run:tenant-run');
      expect((r.content as { app?: string }).app).toBe('acme');
      expect(r.traceId).toBe(runTraceId('tenant-run'));
    }
  });

  it("leaves the control plane's own runs untouched (no namespace, or its own)", async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(
      ctxFor(engine, records, { topology: 'control-plane', namespace: 'ops' }),
    );
    engine.register('checkout', '1', async () => 'ok');
    await engine.start('checkout', {}, 'own-ns', { namespace: 'ops' });
    await engine.waitForRun('own-ns');
    await runBoth(engine);

    for (const runId of ['own-run', 'own-ns']) {
      const own = of(records, runId);
      expect(own.length).toBeGreaterThan(0);
      for (const r of own) {
        expect(r.tags?.some((t) => t.startsWith('app:'))).toBe(false);
        expect('app' in (r.content as object)).toBe(false);
      }
    }
  });

  it('standalone: unchanged, no app tag on a namespaced run', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(ctxFor(engine, records, undefined));

    await runBoth(engine);

    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r.tags?.some((t) => t.startsWith('app:'))).toBe(false);
  });

  describe("Telescope's tenant watchers", () => {
    const RUNTIME = Symbol.for('@dudousxd/nestjs-telescope:runtime');
    const slot = globalThis as Record<symbol, unknown>;
    let saved: unknown;
    beforeEach(() => {
      saved = slot[RUNTIME];
    });
    afterEach(() => {
      slot[RUNTIME] = saved;
    });

    it('a control plane names `durable` as a watcher it runs for its tenants, until unregistered', () => {
      const tenantWatchers = new Map<string, number>();
      slot[RUNTIME] = { tenantWatchers };
      const watcher = new DurableTelescopeWatcher();
      const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
      watcher.register(ctxFor(engine, [], { topology: 'control-plane' }));
      expect([...tenantWatchers.keys()]).toEqual(['durable']);
      // Registering again (a re-boot) does not hold it twice.
      watcher.register(ctxFor(engine, [], { topology: 'control-plane' }));
      expect(tenantWatchers.get('durable')).toBe(1);
      watcher.unregister();
      expect(tenantWatchers.has('durable')).toBe(false);
    });

    it('a runtime from a Telescope that predates the list gets one', () => {
      const runtime: { tenantWatchers?: Map<string, number> } = {};
      slot[RUNTIME] = runtime;
      const watcher = new DurableTelescopeWatcher();
      watcher.register(
        ctxFor(new WorkflowEngine({ store: new InMemoryStateStore() }), [], {
          topology: 'control-plane',
        }),
      );
      expect(runtime.tenantWatchers?.has('durable')).toBe(true);
      watcher.unregister();
    });

    it('standalone, or without Telescope in the process: nothing is named', () => {
      const tenantWatchers = new Map<string, number>();
      slot[RUNTIME] = { tenantWatchers };
      const standalone = new DurableTelescopeWatcher();
      standalone.register(
        ctxFor(new WorkflowEngine({ store: new InMemoryStateStore() }), [], undefined),
      );
      expect(tenantWatchers.size).toBe(0);
      standalone.unregister();

      slot[RUNTIME] = undefined;
      const alone = new DurableTelescopeWatcher();
      expect(() =>
        alone.register(
          ctxFor(new WorkflowEngine({ store: new InMemoryStateStore() }), [], {
            topology: 'control-plane',
          }),
        ),
      ).not.toThrow();
      alone.unregister();
    });
  });

  it('derives the same run trace id as core, so a tenant pod and the control plane join', () => {
    for (const id of ['r1', 'tenant-run', 'parent::fan:1']) {
      expect(runTraceId(id)).toBe(coreRunTraceId(id));
    }
  });
});

describe('durable providers with query.app', () => {
  it('count one app through the store namespace', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('boom', '1', async () => {
      throw new Error('x');
    });
    for (const [id, namespace] of [
      ['a1', 'acme'],
      ['a2', 'acme'],
      ['b1', 'beta'],
    ] as const) {
      await engine.start('boom', {}, id, { namespace });
      await engine.waitForRun(id).catch(() => undefined);
    }
    const ctx = {
      config: {},
      moduleRef: { get: (t: unknown) => (t === STATE_STORE_CANONICAL ? store : engine) },
    } as unknown as ExtensionContext;
    const status = (await store.getRun('a1'))?.status;
    const count = async (app?: string) =>
      (
        (await durableStateProvider().resolve({ status, ...(app ? { app } : {}) }, ctx)) as {
          value: number;
        }
      ).value;
    expect(await count()).toBe(3);
    expect(await count('acme')).toBe(2);
    expect(await count('beta')).toBe(1);
  });

  it("read one app's entries by its app tag", async () => {
    const reads: Array<Record<string, unknown>> = [];
    const storage = {
      get: async (q: Record<string, unknown>) => {
        reads.push(q);
        return { data: [] };
      },
    };
    const ctx = {
      config: {},
      moduleRef: { get: (t: unknown) => (t === TELESCOPE_STORAGE ? storage : undefined) },
    } as unknown as ExtensionContext;
    await durableThroughputProvider().resolve({ app: 'acme' }, ctx);
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q.tag).toBe('app:acme');
  });

  it("keep one app's worker groups", async () => {
    const engine = {
      workerHealth: async () => [
        { group: 'charge@acme', depth: 1, liveWorkers: [] },
        { group: 'charge@beta', depth: 0, liveWorkers: [{}] },
      ],
    };
    const ctx = {
      config: {},
      moduleRef: { get: () => engine },
    } as unknown as ExtensionContext;
    const rows = (
      (await durableWorkerHealthProvider().resolve({ app: 'acme' }, ctx)) as {
        rows: Array<{ group: string }>;
      }
    ).rows;
    expect(rows.map((r) => r.group)).toEqual(['charge@acme']);
  });
});
