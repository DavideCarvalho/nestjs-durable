import { z } from 'zod';
import { WorkflowEngine } from './engine';
import type { RemoteStepDef, RemoteTask } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

/** Records every RemoteTask the engine dispatches, then delegates to the real in-memory worker. */
class RecordingTransport extends InMemoryTransport {
  readonly dispatched: RemoteTask[] = [];
  override async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
    await super.dispatch(task);
  }
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('remote-step priority reaches the dispatched task', () => {
  it('stamps the per-call priority onto the RemoteTask sent to the transport', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport();
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.call(chargeCard, { amount: 42 }, { priority: 7 });
      return charge.chargeId;
    });

    await startRun(engine, 'checkout', {}, 'run1');
    await settle(store, 'run1');

    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]?.priority).toBe(7);
  });

  it('omits priority on the RemoteTask when the call did not set one', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport();
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.call(chargeCard, { amount: 1 });
      return charge.chargeId;
    });

    await startRun(engine, 'checkout', {}, 'run1');
    await settle(store, 'run1');

    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]?.priority).toBeUndefined();
  });
});
