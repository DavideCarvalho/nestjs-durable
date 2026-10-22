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

  it('redelivers a result whose handler threw, and reports the error instead of an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const errors: unknown[] = [];
    const transport = new EventEmitterTransport(new EventEmitter2(), {
      onError: (err) => errors.push(err),
    });
    transport.handle('payments.charge-card', async () => 'ok');
    let calls = 0;
    const settled: StepResult[] = [];
    transport.onResult(async (r) => {
      calls += 1;
      if (calls === 1) throw new Error('store unreachable');
      settled.push(r);
    });
    try {
      await transport.dispatch(task());
      const deadline = Date.now() + 2_000;
      while (settled.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(settled).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await transport.close();
    }
  });

  it('stops redelivering once closed', async () => {
    const transport = new EventEmitterTransport(new EventEmitter2(), { onError: () => {} });
    transport.handle('payments.charge-card', async () => 'ok');
    let calls = 0;
    transport.onResult(async () => {
      calls += 1;
      throw new Error('store unreachable');
    });
    await transport.dispatch(task());
    await waitFor(() => calls > 0);
    await transport.close();
    const seen = calls;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toBe(seen);
  });

  it('a throwing heartbeat handler is reported, not an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const emitter = new EventEmitter2();
    const transport = new EventEmitterTransport(emitter, { onError: (err) => errors.push(err) });
    transport.onHeartbeat(async () => {
      throw new Error('store unreachable');
    });
    emitter.emit('durable.heartbeat', { runId: 'r1', seq: 0, stepId: 'r1:0', group: 'g' });
    await waitFor(() => errors.length > 0);
    expect(errors).toHaveLength(1);
  });
});
