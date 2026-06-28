import { WorkflowService } from '@dudousxd/nestjs-durable';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * Signals are buffered, so the approval can be delivered even before the run reaches the approval
 * wait (the remote `charge-card` step suspends first and resumes asynchronously). Signal once, then
 * poll the run until it settles terminally.
 */
async function signalAndSettle(
  workflows: WorkflowService,
  runId: string,
  token: string,
  payload: unknown,
) {
  await workflows.signal(token, payload); // buffered if the run isn't waiting yet — delivered on arrival
  for (let i = 0; i < 500; i += 1) {
    const r = await workflows.waitForRun(runId);
    if (r.status !== 'suspended') return r;
    await new Promise((res) => setImmediate(res));
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('checkout workflow (end-to-end)', () => {
  it('runs local + remote steps, suspends for approval, then ships on signal', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const workflows = moduleRef.get(WorkflowService);

    // reserveStock (local) → charge-card (remote, @Step, suspends) → waits for approval
    await workflows.start('checkout', { id: 'o1', total: 4200 }, 'run1');
    const started = await workflows.waitForRun('run1');
    expect(started.status).toBe('suspended');

    // Once charge-card resolves, the run waits for approval; approving it ships the order.
    const done = await signalAndSettle(workflows, 'run1', 'approve:o1', { approved: true });
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ status: 'shipped', chargeId: 'ch_o1_4200' });

    await moduleRef.close();
  });

  it('rejects when approval is declined', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const workflows = moduleRef.get(WorkflowService);

    await workflows.start('checkout', { id: 'o2', total: 999 }, 'run2');
    await workflows.waitForRun('run2');
    const done = await signalAndSettle(workflows, 'run2', 'approve:o2', { approved: false });

    expect(done?.status).toBe('completed');
    expect(done?.output).toMatchObject({ status: 'rejected' });

    await moduleRef.close();
  });
});
