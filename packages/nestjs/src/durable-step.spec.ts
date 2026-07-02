import { InMemoryStateStore, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { Step } from './decorators';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

@Injectable()
class PaymentsWorker {
  @Step('payments.charge-card')
  async charge(input: { amount: number }) {
    return { chargeId: `ch_${input.amount}` };
  }
}

@Workflow({ name: 'checkout', version: '1' })
class CheckoutWorkflow {
  constructor(private readonly payments: PaymentsWorker) {}

  async run(ctx: WorkflowCtx, order: { amount: number }) {
    // Method-reference dispatch: the name routed to is the one `@Step('payments.charge-card')`
    // stamped on `charge`, read via `stepNameOf` — not the string literal here.
    const charge = await ctx.step(this.payments.charge, { amount: order.amount });
    return charge.chargeId;
  }
}

describe('@Step end-to-end (event-emitter transport, single process)', () => {
  it('runs a workflow whose remote step is handled by a @Step provider', async () => {
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

    // The remote @Step suspends the run durably; it resumes when the result lands (async).
    await moduleRef.get(WorkflowService).start('checkout', { amount: 42 }, 'run1');
    let result = await store.getRun('run1');
    for (
      let i = 0;
      i < 50 && result?.status !== 'completed' && result?.status !== 'failed';
      i += 1
    ) {
      await new Promise((r) => setImmediate(r));
      result = await store.getRun('run1');
    }

    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('ch_42');
  });
});
