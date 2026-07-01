import { InMemoryStateStore, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { Workflow } from './decorators';
import { DurableControlPlaneModule, DurableModule } from './durable.module';

@Workflow({ name: 'greet', version: '1' })
class GreetWorkflow {
  async run(ctx: WorkflowCtx, input: { name: string }) {
    return ctx.step('hello', async () => `hello ${input.name}`);
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
      imports: [DurableModule.forRoot({ store })],
      providers: [GreetWorkflow],
    }).compile();
    await moduleRef.init();

    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('hello davi');
  });

  it('does NOT recover runs when worker is false (a dashboard-only instance)', async () => {
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
      imports: [DurableModule.forRoot({ store, worker: false })],
      providers: [GreetWorkflow],
    }).compile();
    await moduleRef.init();

    // The dashboard-only instance leaves the incomplete run for the workers to pick up.
    expect((await store.getRun('r1'))?.status).toBe('running');
  });

  it('DOES recover runs on a DurableControlPlaneModule (worker:false, drive:true)', async () => {
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
      imports: [DurableControlPlaneModule.forRoot({ store })],
      providers: [GreetWorkflow],
    }).compile();
    await moduleRef.init();

    // A driving control plane recovers the crashed run itself — even though `worker` is forced
    // `false` — instead of leaving it orphaned `running` forever.
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('hello davi');
  });
});
