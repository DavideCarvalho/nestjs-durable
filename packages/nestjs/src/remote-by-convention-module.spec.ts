import {
  type Heartbeat,
  InMemoryStateStore,
  type StepResult,
  type Transport,
  type WorkflowDecision,
  WorkflowEngine,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Reports a live 'processing' group and completes any dispatched workflow task immediately. */
class ConventionTransport implements Transport {
  readonly dispatchedGroups: string[] = [];
  private decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  constructor(private readonly liveGroups: string[] = ['processing']) {}

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return this.liveGroups;
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatchedGroups.push(task.group);
    setImmediate(
      () =>
        void this.decisionHandler?.({
          taskId: task.taskId,
          runId: task.runId,
          status: 'completed',
          commands: [],
          output: { fromConvention: true },
        }),
    );
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

describe('DurableModule — convention dispatch (unconditional)', () => {
  it('routes an unregistered workflow to its live group by convention, no flag needed', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await engine.start('processing', { hello: 'world' }, 'conv-mod-1');
    const run = await settle(store, 'conv-mod-1');

    expect(run?.status).toBe('completed');
    expect(transport.dispatchedGroups).toEqual(['processing']);

    await moduleRef.close();
  });

  it('recognizes a `:`-named workflow via its SANITIZED live group (membership check must sanitize)', async () => {
    // Bug guard: workers register/heartbeat their live group under the sanitized token, so the
    // convention membership check must sanitize `run.workflow` too — else `orders:fulfill` computes
    // `orders:fulfill`, misses the live `orders-fulfill`, and the run is never seen as remotely served.
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport(['orders-fulfill']);
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await engine.start('orders:fulfill', { hello: 'world' }, 'conv-mod-colon');
    const run = await settle(store, 'conv-mod-colon');

    expect(run?.status).toBe('completed');
    expect(transport.dispatchedGroups).toEqual(['orders-fulfill']);

    await moduleRef.close();
  });

  it('a workflow with no live group at all still throws "not registered"', async () => {
    const store = new InMemoryStateStore();
    const transport = new ConventionTransport([]);
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport })],
    }).compile();
    await moduleRef.init();

    const engine = moduleRef.get(WorkflowEngine, { strict: false });
    await expect(engine.start('processing', {}, 'conv-mod-2')).rejects.toThrow('not registered');

    await moduleRef.close();
  });
});
