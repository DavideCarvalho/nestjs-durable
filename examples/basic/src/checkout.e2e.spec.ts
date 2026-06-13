import { WorkflowService } from '@dudousxd/nestjs-durable';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * The remote `charge-card` step now suspends the run durably and resumes when its result lands
 * (asynchronously). So the run reaches the approval wait a few ticks AFTER `start` returns — retry
 * the approval signal until the waiter exists.
 */
async function signalWhenReady(workflows: WorkflowService, token: string, payload: unknown) {
  for (let i = 0; i < 100; i += 1) {
    const result = await workflows.signal(token, payload);
    if (result) return result;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`no run ever waited on ${token}`);
}

describe('checkout workflow (end-to-end)', () => {
  it('runs local + remote steps, suspends for approval, then ships on signal', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const workflows = moduleRef.get(WorkflowService);

    // reserveStock (local) → charge-card (remote, @DurableStep, suspends) → waits for approval
    const started = await workflows.start('checkout', { id: 'o1', total: 4200 }, 'run1');
    expect(started.status).toBe('suspended');

    // Once charge-card resolves, the run waits for approval; approving it ships the order.
    const done = await signalWhenReady(workflows, 'approve:o1', { approved: true });
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ status: 'shipped', chargeId: 'ch_o1_4200' });

    await moduleRef.close();
  });

  it('rejects when approval is declined', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const workflows = moduleRef.get(WorkflowService);

    await workflows.start('checkout', { id: 'o2', total: 999 }, 'run2');
    const done = await signalWhenReady(workflows, 'approve:o2', { approved: false });

    expect(done?.status).toBe('completed');
    expect(done?.output).toMatchObject({ status: 'rejected' });

    await moduleRef.close();
  });
});
