import { InMemoryStateStore, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

@Workflow({ name: 'greet', version: '1' })
class GreetWorkflow {
  async run(ctx: WorkflowCtx, input: { name: string }) {
    return ctx.step('hello', async () => `hello ${input.name}`);
  }
}

describe('DurableModule', () => {
  it('discovers a @Workflow provider and runs it via WorkflowService', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store })],
      providers: [GreetWorkflow],
    }).compile();
    await moduleRef.init();

    const service = moduleRef.get(WorkflowService);
    const result = await service.start('greet', { name: 'davi' }, 'run1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe('hello davi');
  });
});
