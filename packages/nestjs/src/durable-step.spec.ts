import {
  InMemoryStateStore,
  type RemoteStepDef,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { DurableStep } from './decorators';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

@Injectable()
class PaymentsWorker {
  @DurableStep('payments.charge-card')
  async charge(input: { amount: number }) {
    return { chargeId: `ch_${input.amount}` };
  }
}

@Workflow({ name: 'checkout', version: '1' })
class CheckoutWorkflow {
  async run(ctx: WorkflowCtx, order: { amount: number }) {
    const charge = await ctx.call(chargeCard, { amount: order.amount });
    return charge.chargeId;
  }
}

describe('@DurableStep end-to-end (event-emitter transport, single process)', () => {
  it('runs a workflow whose remote step is handled by a @DurableStep provider', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        DurableModule.forRootAsync({
          inject: [EventEmitter2],
          useFactory: (emitter: EventEmitter2) => ({
            store,
            transport: new EventEmitterTransport(emitter),
          }),
        }),
      ],
      providers: [PaymentsWorker, CheckoutWorkflow],
    }).compile();
    await moduleRef.init();

    const result = await moduleRef.get(WorkflowService).start('checkout', { amount: 42 }, 'run1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_42');
  });
});
