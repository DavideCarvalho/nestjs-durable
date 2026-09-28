import {
  ConcurrencyLimitError,
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

@Workflow({
  name: 'capped',
  version: '1',
  concurrency: { key: (input) => `tenant:${(input as { tenant: string }).tenant}`, limit: 1 },
})
class CappedWorkflow {
  async run(ctx: WorkflowCtx) {
    return ctx.waitForSignal('never');
  }
}

describe('@Workflow concurrency', () => {
  it('rejects a start over the declared per-key quota', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 }),
      ],
      providers: [CappedWorkflow],
    }).compile();
    await moduleRef.init();

    const svc = moduleRef.get(WorkflowService);
    await svc.start('capped', { tenant: 'a' }, 'a1');
    await expect(svc.start('capped', { tenant: 'a' }, 'a2')).rejects.toBeInstanceOf(
      ConcurrencyLimitError,
    );
    await svc.start('capped', { tenant: 'b' }, 'b1');
    expect(await store.getRun('a2')).toBeNull();
    await moduleRef.close();
  });
});
