import type { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableModuleOptions } from './durable.module';
import { RetentionPoller } from './retention-poller';
import { TimerPoller } from './timer-poller';

/**
 * Both pollers await a sweep inside `onApplicationBootstrap` and fire it as `void` on an interval.
 * A rejection out of either path is fatal — the first kills `NestApplication.init()`, the second is
 * an unhandled rejection — and since the state that caused it survives the restart, the pod
 * crash-loops. These tests pin the sweeps as non-throwing.
 */

/** A driving operator: `store` set, `drive` not disabled. */
function drivingOptions(extra: Partial<DurableModuleOptions> = {}): DurableModuleOptions {
  return { store: {}, timerPollMs: 0, ...extra } as unknown as DurableModuleOptions;
}

function engineWith(overrides: Partial<Record<string, unknown>> = {}): WorkflowEngine {
  return {
    onEnqueued: vi.fn(() => () => {}),
    runOne: vi.fn(async () => undefined),
    runPending: vi.fn(async () => []),
    recoverIncomplete: vi.fn(async () => []),
    resumeDueTimers: vi.fn(async () => []),
    sweepTimeouts: vi.fn(async () => []),
    ...overrides,
  } as unknown as WorkflowEngine;
}

let errors: unknown[][];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimerPoller', () => {
  it('boots even though a sweep throws', async () => {
    // The reported failure: `workflow x@1 is not registered` out of recoverIncomplete took down every
    // worker in the deployment, on every restart, for as long as the run existed.
    const engine = engineWith({
      recoverIncomplete: vi.fn(async () => {
        throw new Error('workflow ghost@1 is not registered (skew protection)');
      }),
    });
    const poller = new TimerPoller(engine, drivingOptions());

    await expect(poller.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(errors.flat().some((arg) => String(arg).includes('recoverIncomplete'))).toBe(true);
  });

  it('runs the sweeps behind a failing one', async () => {
    // A store that cannot recover runs says nothing about whether durable timers should fire. Ending
    // the tick at the first failure quietly widens one subsystem's outage into all of them.
    const engine = engineWith({
      runPending: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
    });
    const poller = new TimerPoller(engine, drivingOptions());

    await poller.onApplicationBootstrap();

    expect(engine.recoverIncomplete).toHaveBeenCalled();
    expect(engine.resumeDueTimers).toHaveBeenCalled();
    expect(engine.sweepTimeouts).toHaveBeenCalled();
  });

  it('survives a schedule that throws', async () => {
    const poller = new TimerPoller(
      engineWith(),
      drivingOptions({
        schedules: [{ workflow: 'nope', cron: 'not a cron' }],
      } as Partial<DurableModuleOptions>),
    );

    await expect(poller.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('claims the rejection of a run it was told to pick up', async () => {
    // `onEnqueued` is fire-and-forget, so an unclaimed rejection here reaches the process handler.
    const engine = engineWith({
      runOne: vi.fn(async () => {
        throw new Error('workflow ghost@1 is not registered (skew protection)');
      }),
    });
    let notify: ((runId: string) => void) | undefined;
    (engine.onEnqueued as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (listener: (runId: string) => void) => {
        notify = listener;
        return () => {};
      },
    );
    const poller = new TimerPoller(engine, drivingOptions());
    await poller.onApplicationBootstrap();

    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    notify?.('run-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', record);

    expect(unhandled).toEqual([]);
    expect(errors.flat().some((arg) => String(arg).includes('run-1'))).toBe(true);
  });

  it('does not swallow a sweep that succeeds', async () => {
    const engine = engineWith();
    const poller = new TimerPoller(engine, drivingOptions());

    await poller.onApplicationBootstrap();

    expect(engine.runPending).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });
});

describe('RetentionPoller', () => {
  it('boots even though pruning throws', async () => {
    const store = {
      pruneTerminalRuns: vi.fn(async () => {
        throw new Error('Lock wait timeout exceeded');
      }),
    };
    const poller = new RetentionPoller(
      store as never,
      drivingOptions({
        retention: { policies: [{ statuses: ['completed'], maxAge: '7d' }] },
      } as Partial<DurableModuleOptions>),
    );

    await expect(poller.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(store.pruneTerminalRuns).toHaveBeenCalled();
    expect(errors.flat().some((arg) => String(arg).includes('retention sweep failed'))).toBe(true);
  });
});
