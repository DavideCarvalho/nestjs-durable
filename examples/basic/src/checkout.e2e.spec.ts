import { WorkflowService } from '@dudousxd/nestjs-durable';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('checkout workflow (end-to-end)', () => {
  it('runs local + remote steps, suspends for approval, then ships on signal', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const workflows = moduleRef.get(WorkflowService);

    // reserveStock (local) → charge-card (remote, @DurableStep) → waits for approval
    const started = await workflows.start('checkout', { id: 'o1', total: 4200 }, 'run1');
    expect(started.status).toBe('suspended');

    // A human (or webhook) approves → the run resumes and ships.
    const done = await workflows.signal('approve:o1', { approved: true });
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ status: 'shipped', chargeId: 'ch_o1_4200' });

    await moduleRef.close();
  });

  it('rejects when approval is declined', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const workflows = moduleRef.get(WorkflowService);

    await workflows.start('checkout', { id: 'o2', total: 999 }, 'run2');
    const done = await workflows.signal('approve:o2', { approved: false });

    expect(done?.status).toBe('completed');
    expect(done?.output).toMatchObject({ status: 'rejected' });

    await moduleRef.close();
  });
});
