import type { RunningWorker } from '@dudousxd/durable-worker';
import { DurableWorkflow, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { Workflow } from './decorators';
import { DurableStartClient } from './durable-start-client';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';

@Workflow({ name: 'tenant-invoice', version: '1' })
class TenantInvoiceWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { n: number }): Promise<number> {
    return input.n;
  }
}

/**
 * Class-first statics on a TENANT (`connection`, no `store`): `MyWorkflow.start()` used to throw
 * "not bound to a durable engine" because only the operator registrar bound the classes.
 */
describe('class statics on a tenant (DurableModule without a store)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('MyWorkflow.start() publishes a start through the tenant start facade, options included', async () => {
    const start = vi
      .spyOn(DurableStartClient.prototype, 'start')
      .mockImplementation(async (_name: unknown, _input: unknown, runId?: string) => ({
        runId: runId ?? 'generated',
        status: 'pending' as const,
      }));
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ connection: 'redis://x', partition: 'acme' })],
      providers: [TenantInvoiceWorkflow],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(async (): Promise<RunningWorker> => ({ close: async () => {} }))
      .compile();
    await moduleRef.init();

    const result = await TenantInvoiceWorkflow.start(
      { n: 1 },
      { id: 'inv-1', priority: 5, version: '1' },
    );

    expect(result).toEqual({ runId: 'inv-1', status: 'pending' });
    expect(start).toHaveBeenCalledWith(
      'tenant-invoice',
      { n: 1 },
      'inv-1',
      expect.objectContaining({ priority: 5, version: '1' }),
    );
    // A tenant has no store to wait on: execute() outside a workflow says so instead of hanging.
    await expect(TenantInvoiceWorkflow.execute({ n: 1 })).rejects.toThrow();

    await moduleRef.close();
  });
});
