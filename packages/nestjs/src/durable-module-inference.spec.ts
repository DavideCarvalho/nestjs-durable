import {
  type Heartbeat,
  InMemoryStateStore,
  InMemoryTransport,
  type RemoteTask,
  type StepResult,
  type Transport,
  type WorkflowDecision,
  WorkflowEngine,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import type { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableStartClient } from './durable-start-client';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { IN_APP_RUN_REDIS_WORKER } from './in-app-worker';
import { ProxyRunGateway } from './proxy-run-gateway';
import { StoreRunGateway } from './store-run-gateway';
import { RUN_GATEWAY } from './tokens';

@Workflow({ name: 'greet', version: '1' })
class GreetWorkflow {
  async run() {
    return 'hi';
  }
}

/** A transport double that carries workflow tasks — the co-located (`store` + `connection`) role
 *  needs `dispatchWorkflowTask` + `onDecision` (the surface `RemoteWorkflowExecutor` binds to). */
class WorkflowTaskTransport implements Transport {
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}
  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}
}

function fakeRunRedisWorker() {
  const calls: unknown[] = [];
  return {
    calls,
    fn: async (opts: unknown) => {
      calls.push(opts);
      return { close: async () => {} };
    },
  };
}

describe('DurableModule.forRoot — role inference', () => {
  it('{ store, transport } => operator: real WorkflowEngine + StoreRunGateway, no runRedisWorker call', async () => {
    const runner = fakeRunRedisWorker();
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport, timerPollMs: 0 })],
      providers: [GreetWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    expect(engine).toBeInstanceOf(WorkflowEngine);
    expect(engine).not.toBeInstanceOf(DurableStartClient);

    const gateway = moduleRef.get(RUN_GATEWAY, { strict: false });
    expect(gateway).toBeInstanceOf(StoreRunGateway);

    expect(runner.calls).toHaveLength(0);

    await moduleRef.close();
  });

  it('{ connection } => thin worker: WorkflowEngine is a DurableStartClient, ProxyRunGateway when transport given, one runRedisWorker call carrying partition, no store', async () => {
    const runner = fakeRunRedisWorker();
    const transport = new InMemoryTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ connection: 'redis://x', partition: 'tenantA', transport }),
      ],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    expect(engine).toBeInstanceOf(DurableStartClient);
    await expect(engine.cancel('r1')).rejects.toThrow(/not available on a tenant worker/);

    const gateway = moduleRef.get(RUN_GATEWAY, { strict: false });
    expect(gateway).toBeInstanceOf(ProxyRunGateway);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ partition: 'tenantA' });

    await moduleRef.close();
  });

  it('{ store, transport, connection } => operator that also runs a co-located worker: real engine + one runRedisWorker + knownGroups per @Workflow', async () => {
    const runner = fakeRunRedisWorker();
    const store = new InMemoryStateStore();
    const transport = new WorkflowTaskTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport,
          connection: 'redis://x',
          partition: 'tenantA',
          timerPollMs: 0,
          autoSchema: false,
        }),
      ],
      providers: [GreetWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine);
    expect(engine).toBeInstanceOf(WorkflowEngine);
    expect(engine).not.toBeInstanceOf(DurableStartClient);
    expect(engine.knownGroups().length).toBe(1);

    // Exactly one co-located consumer started (the in-app-worker's own runner) — the pure
    // thin-worker path (`ThinWorkerBootstrap`) stays inert since `store` is also set.
    expect(runner.calls).toHaveLength(1);

    await moduleRef.close();
  });

  it('forRoot({}) throws: needs either a store or a connection', () => {
    expect(() => DurableModule.forRoot({})).toThrow(
      'a durable module needs either a `store` (operator) or a `connection` (worker)',
    );
  });

  it('forRoot({ store }) with no transport throws: an operator needs a transport', () => {
    const store = new InMemoryStateStore();
    expect(() => DurableModule.forRoot({ store })).toThrow(
      'an operator (`store`) needs a `transport`',
    );
  });
});

describe('DurableModule.forRoot — topology', () => {
  async function boot(options: DurableModuleOptions, providers: Type[] = [GreetWorkflow]) {
    const runner = fakeRunRedisWorker();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot(options)],
      providers,
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();
    return { moduleRef, runner };
  }

  it("'standalone' is the inference of no topology at all", async () => {
    const store = new InMemoryStateStore();
    const { moduleRef } = await boot({
      topology: 'standalone',
      store,
      transport: new InMemoryTransport(),
      timerPollMs: 0,
    });
    expect(moduleRef.get(WorkflowEngine)).not.toBeInstanceOf(DurableStartClient);
    expect(moduleRef.get(RUN_GATEWAY, { strict: false })).toBeInstanceOf(StoreRunGateway);
    await moduleRef.close();

    expect(() => DurableModule.forRoot({ topology: 'standalone' })).toThrow(
      'a durable module needs either a `store` (operator) or a `connection` (worker)',
    );
  });

  it("'control-plane' with store and transport resolves the operator role: real WorkflowEngine + StoreRunGateway", async () => {
    const { moduleRef } = await boot({
      topology: 'control-plane',
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
      timerPollMs: 0,
    });
    const engine = moduleRef.get(WorkflowEngine);
    expect(engine).toBeInstanceOf(WorkflowEngine);
    expect(engine).not.toBeInstanceOf(DurableStartClient);
    const gateway = moduleRef.get(RUN_GATEWAY, { strict: false });
    expect(gateway).toBeInstanceOf(StoreRunGateway);
    expect(gateway.topology()).toEqual({ role: 'control-plane' });
    await moduleRef.close();
  });

  it("'control-plane' missing `transport` throws the topology-specific error", () => {
    expect(() =>
      DurableModule.forRoot({ topology: 'control-plane', store: new InMemoryStateStore() }),
    ).toThrow(/needs `store` AND \(`transport` or `transports`\)/);
  });

  it("'control-plane' with a `partition` scopes the operator to its own runs (it becomes the namespace)", async () => {
    const store = new InMemoryStateStore();
    const { moduleRef } = await boot({
      topology: 'control-plane',
      partition: 'davi-local',
      store,
      transport: new InMemoryTransport(),
      timerPollMs: 0,
    });
    const { runId } = await moduleRef
      .get(WorkflowEngine)
      .start(GreetWorkflow, undefined, 'run-cp-tenant');
    expect((await store.getRun(runId))?.namespace).toBe('davi-local');
    await moduleRef.close();
  });

  it("'control-plane' with `partition: undefined` is a global operator", async () => {
    const store = new InMemoryStateStore();
    const { moduleRef } = await boot({
      topology: 'control-plane',
      partition: undefined,
      store,
      transport: new InMemoryTransport(),
      timerPollMs: 0,
    });
    const { runId } = await moduleRef
      .get(WorkflowEngine)
      .start(GreetWorkflow, undefined, 'run-cp-global');
    expect((await store.getRun(runId))?.namespace).toBe('default');
    await moduleRef.close();
  });

  it("'control-plane' with a MISMATCHED explicit `namespace` throws; a matching one is a no-op", async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    expect(() =>
      DurableModule.forRoot({
        topology: 'control-plane',
        partition: 'davi-local',
        store,
        transport,
        namespace: 'someone-else',
      }),
    ).toThrow(/conflicts with `namespace: 'someone-else'`/);

    const { moduleRef } = await boot({
      topology: 'control-plane',
      partition: 'davi-local',
      store,
      transport,
      namespace: 'davi-local',
      timerPollMs: 0,
    });
    const { runId } = await moduleRef
      .get(WorkflowEngine)
      .start(GreetWorkflow, undefined, 'run-cp-match');
    expect((await store.getRun(runId))?.namespace).toBe('davi-local');
    await moduleRef.close();
  });

  it("'tenant' resolves the worker role: it serves its partition and ProxyRunGateway reports it", async () => {
    const { moduleRef, runner } = await boot(
      {
        topology: 'tenant',
        partition: 'tenantA',
        connection: 'redis://x',
        transport: new InMemoryTransport(),
      },
      [],
    );
    expect(moduleRef.get(WorkflowEngine)).toBeInstanceOf(DurableStartClient);
    const gateway = moduleRef.get(RUN_GATEWAY, { strict: false });
    expect(gateway).toBeInstanceOf(ProxyRunGateway);
    expect(gateway.topology()).toEqual({ role: 'tenant', tenant: 'tenantA' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ partition: 'tenantA' });
    await moduleRef.close();
  });

  it("'tenant' without `partition` throws", () => {
    expect(() =>
      DurableModule.forRoot({
        topology: 'tenant',
        connection: 'redis://x',
      } as unknown as DurableModuleOptions),
    ).toThrow(/topology: 'tenant' needs `partition`/);
  });

  it("'tenant' without `connection` throws", () => {
    expect(() =>
      DurableModule.forRoot({
        topology: 'tenant',
        partition: 'tenantA',
      } as unknown as DurableModuleOptions),
    ).toThrow(/needs `connection`/);
  });

  it("'tenant' with `store` throws: a tenant is store-less by definition", () => {
    expect(() =>
      DurableModule.forRoot({
        topology: 'tenant',
        partition: 'tenantA',
        connection: 'redis://x',
        store: new InMemoryStateStore(),
        transport: new InMemoryTransport(),
      } as unknown as DurableModuleOptions),
    ).toThrow(/forbids `store`/);
  });

  it("'tenant' with `namespace` throws: namespace is the operator's axis", () => {
    expect(() =>
      DurableModule.forRoot({
        topology: 'tenant',
        partition: 'tenantA',
        connection: 'redis://x',
        namespace: 'tenantA',
      } as unknown as DurableModuleOptions),
    ).toThrow(/forbids `namespace`/);
  });

  it("'tenant' with `verifyTenant` throws: the control plane verifies", () => {
    expect(() =>
      DurableModule.forRoot({
        topology: 'tenant',
        partition: 'tenantA',
        connection: 'redis://x',
        verifyTenant: () => null,
      } as unknown as DurableModuleOptions),
    ).toThrow(/forbids `verifyTenant`/);
  });

  it("'control-plane' with `tenantToken` throws: the tenant presents it", () => {
    expect(() =>
      DurableModule.forRoot({
        topology: 'control-plane',
        store: new InMemoryStateStore(),
        transport: new InMemoryTransport(),
        tenantToken: 'token',
      } as unknown as DurableModuleOptions),
    ).toThrow(/forbids `tenantToken`/);
  });

  it('an unknown topology, or the removed object form, throws and shows the new form', () => {
    expect(() =>
      DurableModule.forRoot({
        topology: { role: 'tenant', tenant: 'acme' },
        connection: 'redis://x',
      } as unknown as DurableModuleOptions),
    ).toThrow(/is now `topology: 'tenant', partition: 'acme'`/);
    expect(() =>
      DurableModule.forRoot({
        topology: 'worker',
        connection: 'redis://x',
      } as unknown as DurableModuleOptions),
    ).toThrow(/topology must be 'standalone', 'control-plane' or 'tenant'/);
  });

  it('forRootAsync validates the topology the factory returns', async () => {
    const moduleBuilder = Test.createTestingModule({
      imports: [
        DurableModule.forRootAsync({
          useFactory: () =>
            ({ topology: 'tenant', connection: 'redis://x' }) as unknown as DurableModuleOptions,
        }),
      ],
    });
    await expect(moduleBuilder.compile()).rejects.toThrow(/needs `partition`/);
  });
});
