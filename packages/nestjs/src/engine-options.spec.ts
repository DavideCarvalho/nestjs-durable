import {
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableModule, type DurableModuleOptions } from './durable.module';

/**
 * Engine tuning options passed to `DurableModule` must reach the `WorkflowEngine` it builds, through
 * both `forRoot` and `forRootAsync`.
 */

type Extra = Pick<
  DurableModuleOptions,
  'timerBatchSize' | 'reconcileMs' | 'eventBufferTtlMs' | 'blockedPollMs' | 'trackStepStart'
>;

const modules: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(modules.splice(0).map((m) => m.close()));
});

async function engineFor(
  mode: 'forRoot' | 'forRootAsync',
  extra: Extra,
): Promise<{ engine: WorkflowEngine; store: InMemoryStateStore }> {
  const store = new InMemoryStateStore();
  const options: DurableModuleOptions = {
    store,
    transport: new InMemoryTransport(),
    drive: false,
    ...extra,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      mode === 'forRoot'
        ? DurableModule.forRoot(options)
        : DurableModule.forRootAsync({ useFactory: async () => options }),
    ],
  }).compile();
  await moduleRef.init();
  modules.push(moduleRef);
  return { engine: moduleRef.get(WorkflowEngine, { strict: false }), store };
}

/** The `limit` the engine's timer pass asks the store for. */
async function timerLimit(engine: WorkflowEngine, store: InMemoryStateStore): Promise<unknown> {
  const spy = vi.spyOn(store, 'listDueTimers');
  await engine.resumeDueTimers();
  expect(spy).toHaveBeenCalled();
  return spy.mock.calls.at(-1)?.[2];
}

describe.each(['forRoot', 'forRootAsync'] as const)('DurableModule.%s engine options', (mode) => {
  it('forwards timerBatchSize to the timer pass', async () => {
    const { engine, store } = await engineFor(mode, { timerBatchSize: 37 });
    expect(await timerLimit(engine, store)).toBe(37);
  });

  it('keeps the engine default batch of 500 when timerBatchSize is omitted', async () => {
    const { engine, store } = await engineFor(mode, {});
    expect(await timerLimit(engine, store)).toBe(500);
  });

  it('forwards reconcileMs, eventBufferTtlMs, blockedPollMs and trackStepStart', async () => {
    const { engine } = await engineFor(mode, {
      reconcileMs: 12_345,
      eventBufferTtlMs: 67_890,
      blockedPollMs: 4_321,
      trackStepStart: false,
    });
    const internals = engine as unknown as Record<string, unknown>;
    expect(internals.reconcileMs).toBe(12_345);
    expect(internals.eventBufferTtlMs).toBe(67_890);
    expect(internals.blockedPollMs).toBe(4_321);
    expect(internals.trackStepStart).toBe(false);
  });

  it('keeps the engine defaults when those options are omitted', async () => {
    const { engine } = await engineFor(mode, {});
    const internals = engine as unknown as Record<string, unknown>;
    expect(internals.reconcileMs).toBe(300_000);
    expect(internals.eventBufferTtlMs).toBeUndefined();
    expect(internals.blockedPollMs).toBe(5_000);
    expect(internals.trackStepStart).toBe(true);
  });
});
