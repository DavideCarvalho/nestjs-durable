import 'reflect-metadata';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { IsInt, IsString } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

class CheckoutInput {
  @IsString() orderId!: string;
  @IsInt() total!: number;
}

@Workflow({ name: 'checkout', version: '1', inputSchema: CheckoutInput })
class CheckoutWorkflow {
  async run() {
    return 'ok';
  }
}

describe('@Workflow inputSchema (class-validator)', () => {
  it('rejects invalid input at start, before creating the run', async () => {
    const store = new InMemoryStateStore();
    const mod = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, timerPollMs: 0 })],
      providers: [CheckoutWorkflow],
    }).compile();
    await mod.init();
    const svc = mod.get(WorkflowService);

    await expect(svc.start('checkout', { orderId: 'o1', total: 'oops' }, 'bad')).rejects.toThrow();
    expect(await store.getRun('bad')).toBeNull();

    const ok = await svc.start('checkout', { orderId: 'o1', total: 5 }, 'good');
    expect(ok.status).toBe('completed');
  });
});
