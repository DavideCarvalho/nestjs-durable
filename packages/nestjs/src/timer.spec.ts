import { InMemoryStateStore, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Workflow({ name: 'sleeper', version: '1' })
class SleeperWorkflow {
  async run(ctx: WorkflowCtx) {
    await ctx.sleep('1h');
    return ctx.step('after', async () => 'awake');
  }
}

describe('durable timers', () => {
  it('resumes a suspended run whose timer is already due, on bootstrap', async () => {
    const store = new InMemoryStateStore();
    const past = 1_000;
    const now = new Date();
    // A run suspended on a sleep whose timer has already elapsed.
    await store.createRun({
      id: 'r1',
      workflow: 'sleeper',
      workflowVersion: '1',
      status: 'suspended',
      input: undefined,
      wakeAt: past,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveCheckpoint({
      runId: 'r1',
      seq: 0,
      name: 'sleep',
      kind: 'sleep',
      stepId: 'r1:0',
      status: 'completed',
      wakeAt: past,
      attempts: 1,
      startedAt: now,
      finishedAt: now,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store })],
      providers: [SleeperWorkflow],
    }).compile();
    await moduleRef.init();

    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('awake');
  });
});
