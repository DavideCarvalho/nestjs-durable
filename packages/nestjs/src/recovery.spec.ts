import {
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Workflow({ name: 'greet', version: '1' })
class GreetWorkflow {
  async run(ctx: WorkflowCtx, input: { name: string }) {
    return ctx.sideEffect(async () => `hello ${input.name}`);
  }
}

describe('boot recovery', () => {
  it('auto-resumes runs left running, on application bootstrap', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    // A run left mid-flight by a previous process.
    await store.createRun({
      id: 'r1',
      workflow: 'greet',
      workflowVersion: '1',
      status: 'running',
      input: { name: 'davi' },
      createdAt: now,
      updatedAt: now,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport() })],
      providers: [GreetWorkflow],
    }).compile();
    await moduleRef.init();

    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('hello davi');
  });

  it('does NOT recover runs when drive is false (a dashboard-only instance)', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'greet',
      workflowVersion: '1',
      status: 'running',
      input: { name: 'davi' },
      createdAt: now,
      updatedAt: now,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport(), drive: false })],
      providers: [GreetWorkflow],
    }).compile();
    await moduleRef.init();

    // The dashboard-only instance leaves the incomplete run for a driving instance to pick up.
    expect((await store.getRun('r1'))?.status).toBe('running');
  });
});
