import type { StateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableModuleOptions } from './durable.module';
import { RetentionPoller } from './retention-poller';
import { TimerPoller } from './timer-poller';

afterEach(() => vi.restoreAllMocks());

/** An engine whose first runPending (the boot poll) is instant and later ones block until released. */
function blockingEngine(extra: Record<string, unknown> = {}) {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const entered = vi.fn();
  const engine = {
    onEnqueued: vi.fn(() => () => {}),
    runPending: vi.fn(async () => {
      if (calls++ === 0) return [];
      entered();
      await gate;
      return [];
    }),
    recoverIncomplete: vi.fn(async () => []),
    resumeDueTimers: vi.fn(async () => []),
    sweepTimeouts: vi.fn(async () => []),
    ...extra,
  } as unknown as WorkflowEngine;
  return { engine, release, entered };
}
const opts = (extra: Partial<DurableModuleOptions> = {}) =>
  ({ store: {}, timerPollMs: 5, ...extra }) as unknown as DurableModuleOptions;
const until = async (fn: () => boolean) => {
  const end = Date.now() + 2_000;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
};

describe('TimerPoller shutdown', () => {
  it('[poller-wait] onModuleDestroy waits for the sweep in flight', async () => {
    const { engine, release, entered } = blockingEngine({ beginDrain: vi.fn() });
    const poller = new TimerPoller(engine, opts());
    await poller.onApplicationBootstrap();
    await until(() => entered.mock.calls.length > 0);

    let done = false;
    const destroying = poller.onModuleDestroy().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    release();
    await destroying;
    expect(done).toBe(true);
  });

  it('[poller-old-core] does not throw against an engine without beginDrain', async () => {
    const { engine, release, entered } = blockingEngine(); // no beginDrain: an older core
    const poller = new TimerPoller(engine, opts());
    await poller.onApplicationBootstrap();
    await until(() => entered.mock.calls.length > 0);
    const destroying = poller.onModuleDestroy();
    release();
    await expect(destroying).resolves.toBeUndefined();
  });

  it('[poller-timeout] gives up after shutdownTimeoutMs, says so, and passes the budget to the engine', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const beginDrain = vi.fn();
    const { engine, release, entered } = blockingEngine({ beginDrain });
    const poller = new TimerPoller(engine, opts({ shutdownTimeoutMs: 40 }));
    await poller.onApplicationBootstrap();
    await until(() => entered.mock.calls.length > 0);

    const started = Date.now();
    await poller.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(beginDrain).toHaveBeenCalledWith(40);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/still running after 40ms/);
    release();
  });

  it('begins the drain even when no sweep is in flight, without a budget', async () => {
    const beginDrain = vi.fn();
    const { engine } = blockingEngine({ beginDrain });
    const poller = new TimerPoller(engine, opts({ timerPollMs: 0 }));
    await poller.onApplicationBootstrap();
    await poller.onModuleDestroy();
    expect(beginDrain).toHaveBeenCalledWith(undefined);
  });
});

describe('RetentionPoller shutdown', () => {
  it('[retention-wait] onModuleDestroy waits for the prune in flight and starts no further batch', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prune = vi.fn(async () => {
      await gate;
      return 2; // a full batch: would loop on, were it not stopping
    });
    const store = { pruneTerminalRuns: prune } as unknown as StateStore;
    const options = {
      store,
      retention: {
        sweepInterval: 0,
        batchSize: 2,
        policies: [{ statuses: ['completed'], maxAge: 1000 }],
      },
    } as unknown as DurableModuleOptions;
    const poller = new RetentionPoller(store, options);
    void poller.onApplicationBootstrap();
    await until(() => prune.mock.calls.length > 0);

    let done = false;
    const destroying = poller.onModuleDestroy().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    release();
    await destroying;
    expect(prune).toHaveBeenCalledTimes(1);
  });
});
