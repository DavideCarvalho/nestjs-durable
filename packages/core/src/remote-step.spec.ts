import { z } from 'zod';
import { WorkflowEngine } from './engine';
import type { RemoteStepDef } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

const chargeCard: RemoteStepDef<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
  __remote: true,
};

describe('WorkflowEngine — remote steps', () => {
  it('dispatches a remote step over the transport and checkpoints its result', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.call(chargeCard, { amount: 42 });
      return charge.chargeId;
    });

    const result = await engine.start('checkout', {}, 'run1');

    expect(result.status).toBe('completed');
    expect(result.output).toBe('ch_42');

    const checkpoints = await store.listCheckpoints('run1');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.kind).toBe('remote');
    expect(checkpoints[0]?.name).toBe('payments.charge-card');
  });

  it('records queue/processing timing and announces a remote step as it starts', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('payments.charge-card', async (input: { amount: number }) => ({
      chargeId: `ch_${input.amount}`,
    }));

    const engine = new WorkflowEngine({ store, transport });
    const events: string[] = [];
    let observedQueueMs: number | undefined;
    engine.subscribe((e) => {
      if (e.type === 'step.started' || e.type === 'step.completed') events.push(e.type);
      if (e.type === 'step.completed') observedQueueMs = e.queueMs;
    });

    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.call(chargeCard, { amount: 42 });
      return charge.chargeId;
    });

    await engine.start('checkout', {}, 'run1');

    // A remote step announces itself as in-flight before it completes.
    expect(events).toEqual(['step.started', 'step.completed']);
    expect(observedQueueMs).toBeGreaterThanOrEqual(0);

    const [cp] = await store.listCheckpoints('run1');
    // The three moments are ordered: dispatched ≤ worker pickup ≤ done.
    expect(cp?.enqueuedAt.getTime()).toBeLessThanOrEqual(cp!.startedAt.getTime());
    expect(cp?.startedAt.getTime()).toBeLessThanOrEqual(cp!.finishedAt.getTime());
    // The checkpoint records what the step was called with, alongside what it returned.
    expect(cp?.input).toEqual({ amount: 42 });
    expect(cp?.output).toEqual({ chargeId: 'ch_42' });
  });

  it('replays a completed remote step from its checkpoint instead of re-dispatching', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let dispatches = 0;
    transport.handle('payments.charge-card', async (input: { amount: number }) => {
      dispatches += 1;
      return { chargeId: `ch_${input.amount}` };
    });

    const engine = new WorkflowEngine({ store, transport });
    let failLocalOnce = true;
    engine.register('checkout', '1', async (ctx) => {
      const charge = await ctx.call(chargeCard, { amount: 42 });
      await ctx.step('after', async () => {
        if (failLocalOnce) {
          failLocalOnce = false;
          throw new Error('boom');
        }
        return 'done';
      });
      return charge.chargeId;
    });

    const first = await engine.start('checkout', {}, 'run1');
    expect(first.status).toBe('failed');

    const second = await engine.resume('run1');
    expect(second.status).toBe('completed');
    expect(second.output).toBe('ch_42');

    // The remote step completed on the first attempt; resume must not dispatch it again.
    expect(dispatches).toBe(1);
  });
});
