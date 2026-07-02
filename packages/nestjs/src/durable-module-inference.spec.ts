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
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableStartClient } from './durable-start-client';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';
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
