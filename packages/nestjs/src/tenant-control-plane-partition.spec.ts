import {
  type Heartbeat,
  InMemoryStateStore,
  type RemoteTask,
  type StepResult,
  type Transport,
  type WorkflowDecision,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { IN_APP_RUN_REDIS_WORKER } from './in-app-worker';

@Workflow({ name: 'greet' })
class GreetWorkflow {
  async run(): Promise<string> {
    return 'hi';
  }
}

/** The co-located role needs a transport carrying workflow tasks (dispatchWorkflowTask + onDecision). */
class WorkflowTaskTransport implements Transport {
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_h: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}
  onDecision(_h: (d: WorkflowDecision) => Promise<void>): void {}
}

function fakeRunRedisWorker() {
  const calls: Array<{ partition?: string }> = [];
  return {
    calls,
    fn: async (opts: { partition?: string }) => {
      calls.push(opts);
      return { close: async () => {} };
    },
  };
}

/**
 * A tenant-scoped control plane stamps its runs with `tenant` and now DISPATCHES their steps to
 * `<name>@<tenant>` (see core's `stepGroup`). Its own co-located worker must therefore SUBSCRIBE the
 * same suffixed tokens — otherwise the node dispatches into queues it is itself not listening on.
 */
describe("control-plane with a tenant: the co-located worker serves the tenant's partition", () => {
  it("{ role: 'control-plane', tenant } + connection subscribes `@<tenant>`, not the bare token", async () => {
    const runner = fakeRunRedisWorker();
    const store = new InMemoryStateStore();
    const transport = new WorkflowTaskTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          topology: { role: 'control-plane', tenant: 'davi-local' },
          store,
          transport,
          connection: 'redis://x',
          timerPollMs: 0,
        }),
      ],
      providers: [GreetWorkflow],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.partition).toBe('davi-local');

    await moduleRef.close();
  });

  it('a control plane with NO tenant (global operator) keeps its worker on the bare token', async () => {
    const runner = fakeRunRedisWorker();
    const store = new InMemoryStateStore();
    const transport = new WorkflowTaskTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          topology: { role: 'control-plane' },
          store,
          transport,
          connection: 'redis://x',
          timerPollMs: 0,
        }),
      ],
      providers: [GreetWorkflow],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.partition).toBeUndefined();

    await moduleRef.close();
  });
});
