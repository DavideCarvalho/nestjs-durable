import 'reflect-metadata';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { type INestApplicationContext, Injectable } from '@nestjs/common';
import {
  InMemoryOutboxStore,
  OutboxDeadLetters,
  OutboxModule,
  OutboxRelay,
  OutboxStorage,
} from '@nestjs/outbox';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workflow } from '../decorators';
import { DurableModule } from '../durable.module';
import { WorkflowService } from '../workflow.service';
import { DurableOutbox, DurableOutboxModule } from './index';

@Workflow({ name: 'outbox-checkout' })
class CheckoutWorkflow {
  async run(ctx: WorkflowCtx, input: { orderId: string }) {
    const paid = await ctx.waitForSignal<{ amount: number }>(`paid:${input.orderId}`);
    return { orderId: input.orderId, amount: paid.amount };
  }
}

const outboxStore = () => new InMemoryOutboxStore();

/** The app's outbox store provider, registered with the official registry (in memory, tx-aware). */
function storeProvider(store: InMemoryOutboxStore) {
  @Injectable()
  class AppOutboxStore {
    constructor(storage: OutboxStorage) {
      storage.registerSource({ messages: store, inbox: store });
    }
  }
  return AppOutboxStore;
}

async function boot(opts: { topic?: string } = {}) {
  const store = outboxStore();
  const runs = new InMemoryStateStore();
  const mod = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({ store: runs, transport: new InMemoryTransport(), timerPollMs: 0 }),
      // The relay is driven by hand (`runOnce`) so each test decides when delivery happens.
      OutboxModule.forRoot({ relay: { enabled: false }, retry: { attempts: 3, backoff: () => 0 } }),
      DurableOutboxModule.forRoot(opts),
    ],
    providers: [CheckoutWorkflow, storeProvider(store)],
  }).compile();
  await mod.init();
  return {
    mod: mod as INestApplicationContext,
    store,
    runs,
    outbox: mod.get(DurableOutbox),
    relay: mod.get(OutboxRelay),
    svc: mod.get(WorkflowService),
    engine: mod.get(WorkflowEngine),
  };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.restoreAllMocks();
});

describe('DurableOutbox (@nestjs/outbox)', () => {
  it('starts the run only after the transaction commits', async () => {
    const t = await boot();
    close = () => t.mod.close();

    const { runId } = await t.store.transaction(async (tx) => {
      const started = await t.outbox.start(
        tx,
        CheckoutWorkflow,
        { orderId: 'o1' },
        { runId: 'checkout:o1' },
      );
      // Inside the transaction nothing is visible to the relay yet.
      expect((await t.relay.runOnce()).claimed ?? 0).toBe(0);
      return started;
    });
    expect(runId).toBe('checkout:o1');
    expect(await t.runs.getRun('checkout:o1')).toBeNull();

    await t.relay.runOnce();
    expect((await t.svc.waitForRun('checkout:o1')).status).toBe('suspended');
    const run = await t.runs.getRun('checkout:o1');
    expect(run?.workflow).toBe('outbox-checkout');
    expect(run?.input).toEqual({ orderId: 'o1' });
  });

  it('starts nothing when the transaction rolls back', async () => {
    const t = await boot();
    close = () => t.mod.close();

    await expect(
      t.store.transaction(async (tx) => {
        await t.outbox.start(tx, 'outbox-checkout', { orderId: 'o2' }, { runId: 'checkout:o2' });
        throw new Error('order insert failed');
      }),
    ).rejects.toThrow('order insert failed');

    await t.relay.runOnce();
    expect(await t.runs.getRun('checkout:o2')).toBeNull();
    expect((await t.runs.listRuns({ limit: 10 })).length).toBe(0);
  });

  it('a redelivered start (handler crashed after starting) leaves exactly one run', async () => {
    const t = await boot();
    close = () => t.mod.close();
    const realStart = t.engine.start.bind(t.engine);
    const start = vi.spyOn(t.engine, 'start');
    // First delivery: the run is created, then the process "dies" before the inbox records it.
    start.mockImplementationOnce(async (...args: Parameters<typeof realStart>) => {
      await realStart(...args);
      throw new Error('crashed after start');
    });

    await t.store.transaction((tx) =>
      t.outbox.start(tx, CheckoutWorkflow, { orderId: 'o3' }, { runId: 'checkout:o3' }),
    );
    await t.relay.runOnce(); // fails → rescheduled
    await t.relay.runOnce(); // redelivered → no-op start of the existing run

    expect(start).toHaveBeenCalledTimes(2);
    expect((await t.runs.listRuns({ limit: 10 })).map((r) => r.id)).toEqual(['checkout:o3']);
    // Delivered on the second attempt: nothing left for the relay, nothing dead-lettered.
    expect((await t.relay.runOnce()).claimed ?? 0).toBe(0);
    expect(await t.mod.get(OutboxDeadLetters).list()).toEqual([]);
  });

  it('chooses the run id at write time when none is given, so redelivery reuses it', async () => {
    const t = await boot();
    close = () => t.mod.close();
    const { runId } = await t.store.transaction((tx) =>
      t.outbox.start(tx, CheckoutWorkflow, { orderId: 'o4' }),
    );
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    await t.relay.runOnce();
    expect((await t.runs.getRun(runId))?.workflow).toBe('outbox-checkout');
  });

  it('delivers a signal written in a transaction after commit', async () => {
    const t = await boot({ topic: 'durable-custom' });
    close = () => t.mod.close();
    await t.svc.start(CheckoutWorkflow, { orderId: 'o5' }, 'checkout:o5');
    expect((await t.svc.waitForRun('checkout:o5')).status).toBe('suspended');

    await t.store.transaction((tx) => t.outbox.signal(tx, 'paid:o5', { amount: 42 }));
    expect((await t.runs.getRun('checkout:o5'))?.status).toBe('suspended');
    await t.relay.runOnce();

    const done = await t.svc.waitForRun('checkout:o5', { until: 'terminal' });
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ orderId: 'o5', amount: 42 });
  });

  it('dead-letters a start of an unknown workflow after the retry budget', async () => {
    const t = await boot();
    close = () => t.mod.close();
    await t.store.transaction((tx) => t.outbox.start(tx, 'no-such-workflow', {}, { runId: 'x' }));
    for (let i = 0; i < 3; i++) await t.relay.runOnce();
    const dead = await t.mod.get(OutboxDeadLetters).list();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.payload).toMatchObject({ kind: 'start', workflow: 'no-such-workflow' });
  });
});
