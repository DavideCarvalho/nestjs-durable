import type { RemoteTask, StepResult } from '@dudousxd/nestjs-durable-core';
import { EventEmitter2 } from 'eventemitter2';
import { EventEmitterTransport } from './event-emitter-transport';

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq: 0,
  name: 'payments.charge-card',
  stepId: 'r1:0',
  group: 'payments',
  input: { amount: 10 },
  attempt: 1,
  ...over,
});

// The transport delivers results on a later tick (so a durable ctx.call suspends first); poll.
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('EventEmitterTransport', () => {
  it('routes a dispatched task to a registered handler and delivers the result', async () => {
    const transport = new EventEmitterTransport(new EventEmitter2());
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const results: StepResult[] = [];
    transport.onResult(async (r) => {
      results.push(r);
    });

    await transport.dispatch(task());
    await waitFor(() => results.length > 0);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('completed');
    expect(results[0]?.output).toEqual({ chargeId: 'ch_10' });
    expect(results[0]?.stepId).toBe('r1:0');
  });

  it('reports a failed result when the handler throws', async () => {
    const transport = new EventEmitterTransport(new EventEmitter2());
    transport.handle('payments.charge-card', async () => {
      throw new Error('declined');
    });

    const results: StepResult[] = [];
    transport.onResult(async (r) => {
      results.push(r);
    });

    await transport.dispatch(task());
    await waitFor(() => results.length > 0);

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error?.message).toBe('declined');
  });
});
