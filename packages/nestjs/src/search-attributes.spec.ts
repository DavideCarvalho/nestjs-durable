import 'reflect-metadata';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { Workflow, getWorkflowMeta } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

const orderAttrs = z.object({
  tier: z.enum(['free', 'pro']),
  amount: z.number(),
});

describe('@Workflow searchAttributes', () => {
  it('stores the declared schema on the resolved WorkflowMeta', () => {
    @Workflow({ name: 'meta-only', searchAttributes: orderAttrs })
    class MetaOnlyWorkflow {
      async run() {
        return 'ok';
      }
    }

    expect(getWorkflowMeta(MetaOnlyWorkflow)?.searchAttributes).toBe(orderAttrs);
  });

  it('leaves searchAttributes undefined when the option is omitted', () => {
    @Workflow({ name: 'no-schema' })
    class NoSchemaWorkflow {
      async run() {
        return 'ok';
      }
    }

    expect(getWorkflowMeta(NoSchemaWorkflow)?.searchAttributes).toBeUndefined();
  });

  it('threads the schema through the registrar: a valid upsert completes and persists', async () => {
    @Workflow({ name: 'checkout-ok', searchAttributes: orderAttrs })
    class CheckoutOkWorkflow {
      async run(ctx: WorkflowCtx) {
        await ctx.upsertSearchAttributes({ tier: 'pro', amount: 10 });
        return 'ok';
      }
    }

    const store = new InMemoryStateStore();
    const mod = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 }),
      ],
      providers: [CheckoutOkWorkflow],
    }).compile();
    await mod.init();
    const svc = mod.get(WorkflowService);

    await svc.start('checkout-ok', {}, 'good');
    const result = await svc.waitForRun('good');

    expect(result.status).toBe('completed');
    expect((await store.getRun('good'))?.searchAttributes).toEqual({ tier: 'pro', amount: 10 });
  });

  it('threads the schema through the registrar: an invalid upsert fails the run, naming the workflow', async () => {
    @Workflow({ name: 'checkout-bad', searchAttributes: orderAttrs })
    class CheckoutBadWorkflow {
      async run(ctx: WorkflowCtx) {
        await ctx.upsertSearchAttributes({ tier: 'pro', amount: 'lots' });
        return 'ok';
      }
    }

    const store = new InMemoryStateStore();
    const mod = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 }),
      ],
      providers: [CheckoutBadWorkflow],
    }).compile();
    await mod.init();
    const svc = mod.get(WorkflowService);

    await svc.start('checkout-bad', {}, 'bad');
    const result = await svc.waitForRun('bad');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('checkout-bad');
    expect(result.error?.message).toContain('amount');
  });
});
