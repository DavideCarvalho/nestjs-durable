import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { ControlPlane, RunQuery, WorkflowRun } from './interfaces';
import { LIFECYCLE_PENDING_TAG } from './lifecycle-events';
import { nextScheduleFireAt, runSchedules } from './scheduler';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/** What an idle poller asks the engine: when it next has work, and the cheap lifecycle sweep. */

const T0 = Date.parse('2026-03-02T00:00:00.000Z');

const controlPlane: ControlPlane = { publishControl: async () => {}, onControl: () => {} };

function settled(id: string, extra: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflow: 'job',
    workflowVersion: '1',
    status: 'completed',
    input: null,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...extra,
  };
}

describe('engine.idleBackoffSupported', () => {
  it('needs a control plane or a run queue', () => {
    const store = new InMemoryStateStore();
    expect(new WorkflowEngine({ store }).idleBackoffSupported).toBe(false);
    expect(new WorkflowEngine({ store, controlPlane }).idleBackoffSupported).toBe(true);
  });
});

describe('engine.nextDueAt', () => {
  it('is the earliest timer, or blocked-run poll due by the bound', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => T0 });
    expect(await engine.nextDueAt(T0 + 60_000)).toBeUndefined();

    await store.createRun(settled('later', { status: 'suspended', wakeAt: T0 + 9_000 }));
    await store.createRun(settled('sooner', { status: 'suspended', wakeAt: T0 + 4_000 }));
    expect(await engine.nextDueAt(T0 + 3_000)).toBeUndefined();
    expect(await engine.nextDueAt(T0 + 60_000)).toBe(T0 + 4_000);

    await store.createRun(settled('blocked', { status: 'blocked', wakeAt: T0 + 2_000 }));
    expect(await engine.nextDueAt(T0 + 60_000)).toBe(T0 + 2_000);
  });

  it('includes a persisted schedule only with persistedSchedules', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => T0 });
    engine.register('job', '1', async () => 1);
    await engine.schedules.create({ id: 'pulse', workflow: 'job', every: 5_000 });
    expect(await engine.nextDueAt(T0 + 60_000)).toBeUndefined();
    expect(await engine.nextDueAt(T0 + 60_000, { persistedSchedules: true })).toBe(T0 + 5_000);
    expect(await engine.nextDueAt(T0 + 4_000, { persistedSchedules: true })).toBeUndefined();
  });
});

describe('sweepLifecycleEvents({ owed: false })', () => {
  it('skips the owed listing and the heal, still sweeps run waits', async () => {
    class CountingStore extends InMemoryStateStore {
      tagged = 0;
      waitReads = 0;
      override async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
        if (query.tag === LIFECYCLE_PENDING_TAG) this.tagged += 1;
        return super.listRuns(query);
      }
      override async listSignalWaiters(prefix: string) {
        this.waitReads += 1;
        return super.listSignalWaiters(prefix);
      }
    }
    const store = new CountingStore();
    const engine = new WorkflowEngine({ store, clock: () => T0 });
    await engine.sweepLifecycleEvents(T0, 100, { owed: false });
    expect(store.tagged).toBe(0);
    expect(store.waitReads).toBe(1);
    await engine.sweepLifecycleEvents(T0, 100);
    expect(store.tagged).toBe(1);
    expect(store.waitReads).toBe(2);
  });
});

describe('nextScheduleFireAt', () => {
  it('is the next window boundary of the unpaused schedules', () => {
    const engine = {};
    expect(nextScheduleFireAt(engine, [], T0)).toBeUndefined();
    expect(
      nextScheduleFireAt(
        engine,
        [
          { key: 'a', workflow: 'w', everyMs: 60_000 },
          { key: 'b', workflow: 'w', everyMs: 15_000 },
          { key: 'c', workflow: 'w', everyMs: 1_000, paused: true },
        ],
        T0 + 1,
      ),
    ).toBe(T0 + 15_000);
  });

  it('a cron schedule: its next fire time; unparsable: now', () => {
    expect(nextScheduleFireAt({}, [{ key: 'c', workflow: 'w', cron: '*/5 * * * *' }], T0 + 1)).toBe(
      T0 + 5 * 60_000,
    );
    expect(nextScheduleFireAt({}, [{ key: 'c', workflow: 'w', cron: 'nope' }], T0 + 1)).toBe(
      T0 + 1,
    );
  });

  it('includes a jittered window an earlier tick deferred', async () => {
    const engine = {
      start: vi.fn(async () => ({ runId: 'x', status: 'pending' as const })),
      getRun: vi.fn(async () => null),
    };
    const s = { key: 'j', workflow: 'w', everyMs: 60_000, jitter: 10_000 };
    // The window at T0 is due; jitter defers it to T0 + 5000.
    await runSchedules(engine, [s], T0, { random: () => 0.5 });
    expect(engine.start).not.toHaveBeenCalled();
    expect(nextScheduleFireAt(engine, [s], T0 + 1)).toBe(T0 + 5_000);
  });
});
