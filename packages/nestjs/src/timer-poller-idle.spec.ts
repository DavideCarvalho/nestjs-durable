import type { EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableModuleOptions } from './durable.module';
import { TimerPoller } from './timer-poller';

/**
 * The timer poller's idle cost: the owed-lifecycle listing runs once per `owedLifecycleSweepMs`, and
 * an idle poller backs off to `maxIdleIntervalMs`, never past a known due time, and back to the
 * regular tick on any run event.
 */

function options(extra: Partial<DurableModuleOptions> = {}): DurableModuleOptions {
  return { store: {}, timerPollMs: 1_000, ...extra } as unknown as DurableModuleOptions;
}

interface FakeEngine {
  engine: WorkflowEngine;
  polls: () => number;
  emit: (event: Partial<EngineEvent>) => void;
  enqueue: (runId: string) => void;
  sweepLifecycleEvents: ReturnType<typeof vi.fn>;
  nextDueAt: ReturnType<typeof vi.fn>;
  resumeDueTimers: ReturnType<typeof vi.fn>;
}

function fakeEngine(overrides: Record<string, unknown> = {}): FakeEngine {
  const listeners = new Set<(event: EngineEvent) => void>();
  const enqueued = new Set<(runId: string) => void>();
  const runPending = vi.fn(async () => []);
  const sweepLifecycleEvents = vi.fn(async () => 0);
  const nextDueAt = vi.fn(async () => undefined);
  const resumeDueTimers = vi.fn(async () => []);
  const engine = {
    idleBackoffSupported: true,
    nextDueAt,
    onEnqueued: (fn: (runId: string) => void) => {
      enqueued.add(fn);
      return () => enqueued.delete(fn);
    },
    subscribe: (fn: (event: EngineEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    runEnqueued: vi.fn(),
    runPending,
    recoverIncomplete: vi.fn(async () => []),
    resumeDueTimers,
    sweepTimeouts: vi.fn(async () => undefined),
    sweepLifecycleEvents,
    ...overrides,
  } as unknown as WorkflowEngine;
  return {
    engine,
    polls: () => runPending.mock.calls.length,
    emit: (event) => {
      for (const fn of listeners)
        fn({ type: 'run.suspended', runId: 'r', at: new Date(), ...event });
    },
    enqueue: (runId) => {
      for (const fn of enqueued) fn(runId);
    },
    sweepLifecycleEvents,
    nextDueAt,
    resumeDueTimers,
  };
}

/** Advance fake time in small steps so the poller's awaits settle between its timers. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 50) await vi.advanceTimersByTimeAsync(Math.min(50, left));
}

let poller: TimerPoller | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(async () => {
  await poller?.onModuleDestroy();
  poller = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TimerPoller owed lifecycle sweep', () => {
  it('lists owed runs once per owedLifecycleSweepMs, run waits on every poll', async () => {
    const f = fakeEngine({ idleBackoffSupported: false });
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(25_000);
    const owedFlags = f.sweepLifecycleEvents.mock.calls.map(
      (call) => (call[2] as { owed: boolean }).owed,
    );
    // One sweep per 1 s poll; the owed listing at boot, 10 s and 20 s.
    expect(owedFlags.length).toBeGreaterThanOrEqual(25);
    expect(owedFlags.filter(Boolean)).toHaveLength(3);
    expect(owedFlags[0]).toBe(true);
  });

  it('retries a failed owed listing on the next poll', async () => {
    const f = fakeEngine({ idleBackoffSupported: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    f.sweepLifecycleEvents.mockImplementation(async (_now, _limit, opts: { owed: boolean }) => {
      if (opts.owed && fail) {
        fail = false;
        throw new Error('store down');
      }
      return 0;
    });
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(1_500);
    const owedFlags = f.sweepLifecycleEvents.mock.calls.map(
      (call) => (call[2] as { owed: boolean }).owed,
    );
    // The boot listing failed, so the next poll lists again (and then waits the interval).
    expect(owedFlags.slice(0, 2)).toEqual([true, true]);
    await advance(5_000);
    expect(
      f.sweepLifecycleEvents.mock.calls
        .slice(2)
        .every((call) => !(call[2] as { owed: boolean }).owed),
    ).toBe(true);
  });

  it('owedLifecycleSweepMs: 0 lists on every poll', async () => {
    const f = fakeEngine({ idleBackoffSupported: false });
    poller = new TimerPoller(f.engine, options({ owedLifecycleSweepMs: 0 }));
    await poller.onApplicationBootstrap();
    await advance(3_000);
    expect(
      f.sweepLifecycleEvents.mock.calls.every((call) => (call[2] as { owed: boolean }).owed),
    ).toBe(true);
  });
});

describe('TimerPoller idle backoff', () => {
  it('backs off to 2s, 4s, then 5s while idle', async () => {
    const f = fakeEngine();
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(10);
    expect(f.polls()).toBe(1);
    // Waits of 2, 4, 5, 5 s after the boot poll: polls at 2, 6, 11, 16 s.
    await advance(2_000);
    expect(f.polls()).toBe(2);
    await advance(4_000);
    expect(f.polls()).toBe(3);
    await advance(5_000);
    expect(f.polls()).toBe(4);
    await advance(5_000);
    expect(f.polls()).toBe(5);
  });

  it('never waits past the next known due time', async () => {
    const f = fakeEngine();
    // A timer due 3.2 s after boot.
    const due = Date.now() + 3_200;
    f.nextDueAt.mockImplementation(async (byMs: number) => (due <= byMs ? due : undefined));
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(10);
    // Boot poll, then a 2 s wait (the timer is past it), then a wait cut to the due time.
    await advance(2_000);
    expect(f.polls()).toBe(2);
    await advance(1_250);
    expect(f.polls()).toBe(3);
    expect(f.nextDueAt).toHaveBeenCalled();
  });

  it('keeps the regular tick while polls find work', async () => {
    const f = fakeEngine();
    f.resumeDueTimers.mockImplementation(async () => [{ runId: 'r', status: 'completed' }]);
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(5_010);
    expect(f.polls()).toBe(6);
  });

  it('a run event ends an idle wait at once and resets the backoff', async () => {
    const f = fakeEngine();
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(11_100); // polls at 0, 2, 6, 11 s: now in a 5 s wait
    expect(f.polls()).toBe(4);
    f.emit({ type: 'run.suspended' });
    await advance(10);
    expect(f.polls()).toBe(5);
    // Back to the regular tick after the event, then backing off again.
    await advance(1_000);
    expect(f.polls()).toBe(6);
  });

  it('an enqueue nudge from another instance ends an idle wait', async () => {
    const f = fakeEngine();
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(6_100);
    expect(f.polls()).toBe(3);
    f.enqueue('remote-run');
    await advance(10);
    expect(f.polls()).toBe(4);
  });

  it('keeps the fixed tick when the engine cannot back off, or maxIdleIntervalMs is at the tick', async () => {
    for (const [engineOverrides, extra] of [
      [{ idleBackoffSupported: false }, {}],
      [{ idleBackoffSupported: undefined, nextDueAt: undefined }, {}],
      [{}, { maxIdleIntervalMs: 1_000 }],
    ] as const) {
      const f = fakeEngine(engineOverrides);
      const p = new TimerPoller(f.engine, options(extra));
      await p.onApplicationBootstrap();
      await advance(5_010);
      expect(f.polls()).toBe(6);
      await p.onModuleDestroy();
    }
  });

  it('fires each in-process schedule window no later than the regular tick would', async () => {
    const f = fakeEngine();
    // An every-3s schedule: windows at multiples of 3000 ms of the epoch clock.
    const schedules = [{ key: 'k', workflow: 'wf', everyMs: 3_000 }];
    const firedAt: number[] = [];
    Object.assign(f.engine, {
      start: vi.fn(async () => {
        firedAt.push(Date.now());
        return { runId: 'x', status: 'pending' };
      }),
      getRun: vi.fn(async () => null),
    });
    poller = new TimerPoller(
      f.engine,
      options({ schedules } as unknown as Partial<DurableModuleOptions>),
    );
    await poller.onApplicationBootstrap();
    await advance(15_000);
    // Boot fires the current window; then each window from 1_002_000 to 1_014_000.
    expect(firedAt).toHaveLength(6);
    for (const at of firedAt.slice(1)) expect(at % 3_000).toBeLessThan(1_000);
  });

  it('stops promptly on shutdown during a long wait', async () => {
    const f = fakeEngine();
    poller = new TimerPoller(f.engine, options());
    await poller.onApplicationBootstrap();
    await advance(11_100);
    const before = f.polls();
    await poller.onModuleDestroy();
    poller = undefined;
    await advance(20_000);
    expect(f.polls()).toBe(before);
  });
});
