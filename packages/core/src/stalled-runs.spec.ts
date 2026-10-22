import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StepCheckpoint, WorkflowRun } from './interfaces';
import type { StalledRunInfo } from './stalled-runs';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

function harness(opts: { namespace?: string; stalledAfterMs?: number } = {}) {
  const store = new InMemoryStateStore();
  let now = T0;
  const engine = new WorkflowEngine({
    store,
    clock: () => now,
    runDispatcher: { dispatch: () => {} },
    ...opts,
  });
  return {
    store,
    engine,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

async function seedRun(
  store: InMemoryStateStore,
  id: string,
  patch: Partial<WorkflowRun> & { updatedAgoMs: number },
): Promise<void> {
  const { updatedAgoMs, ...rest } = patch;
  await store.createRun({
    id,
    workflow: 'w',
    workflowVersion: '1',
    status: 'suspended',
    input: {},
    createdAt: new Date(T0 - updatedAgoMs),
    updatedAt: new Date(T0 - updatedAgoMs),
    ...rest,
  });
}

async function seedPendingRemote(
  store: InMemoryStateStore,
  runId: string,
  enqueuedAgoMs: number,
  wakeAt?: number,
): Promise<void> {
  const at = new Date(T0 - enqueuedAgoMs);
  const cp: StepCheckpoint = {
    runId,
    seq: 0,
    name: 'charge',
    kind: 'remote',
    stepId: `${runId}:0`,
    status: 'pending',
    attempts: 1,
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
    ...(wakeAt !== undefined ? { wakeAt } : {}),
  };
  await store.saveCheckpoint(cp);
}

describe('stalled-run pager', () => {
  it('lists the two stranded shapes and leaves healthy long work alone', async () => {
    const { store, engine } = harness();
    // (a) wake-forever: suspended, no wake timer, idle 20 min.
    await seedRun(store, 'forever', { updatedAgoMs: 20 * MIN });
    // (b) old pending remote step, nothing leasing it.
    await seedRun(store, 'lost', { updatedAgoMs: 20 * MIN, wakeAt: T0 + 60 * MIN });
    await seedPendingRemote(store, 'lost', 20 * MIN);
    // A long ctx.sleep: future wakeAt, no pending step.
    await seedRun(store, 'sleeping', { updatedAgoMs: 20 * MIN, wakeAt: T0 + 60 * MIN });
    // An old pending step whose lease (heartbeat / timeout) is still in the future.
    await seedRun(store, 'beating', { updatedAgoMs: 20 * MIN, wakeAt: T0 + 60 * MIN });
    await seedPendingRemote(store, 'beating', 20 * MIN, T0 + 30_000);
    // Wake-forever, but only idle 5 min.
    await seedRun(store, 'recent', { updatedAgoMs: 5 * MIN });
    // Terminal runs are never stalled.
    await seedRun(store, 'done', { updatedAgoMs: 60 * MIN, status: 'completed' });

    const stalled = await engine.listStalledRuns();
    const byId = new Map(stalled.map((s) => [s.run.id, s]));
    expect([...byId.keys()].sort()).toEqual(['forever', 'lost']);
    expect(byId.get('forever')).toMatchObject({ wakeForever: true, stalePending: null });
    expect(byId.get('lost')).toMatchObject({
      wakeForever: false,
      stalePending: { seq: 0, name: 'charge', attempts: 1, ageMs: 20 * MIN, leaseUntil: null },
    });
    expect(byId.get('forever')?.ageMs).toBe(20 * MIN);

    // A tighter threshold widens the net.
    const tight = await engine.listStalledRuns({ thresholdMs: 2 * MIN });
    expect(tight.map((s) => s.run.id).sort()).toEqual(['forever', 'lost', 'recent']);
  });

  it('notifies onStalled once per episode, throttled to a pass a minute', async () => {
    const { store, engine, advance } = harness();
    await seedRun(store, 'forever', { updatedAgoMs: 20 * MIN });
    const seen: StalledRunInfo[] = [];
    engine.onStalled((info) => seen.push(info));

    expect((await engine.sweepStalled()).map((s) => s.run.id)).toEqual(['forever']);
    expect(seen).toHaveLength(1);
    // Within the minute: throttled.
    advance(30_000);
    expect(await engine.sweepStalled()).toEqual([]);
    // Next minute: same episode, not re-paged.
    advance(60_000);
    expect(await engine.sweepStalled()).toEqual([]);
    expect(seen).toHaveLength(1);
    // The run made progress and stranded again: a new episode pages again.
    await store.updateRun('forever', { updatedAt: new Date(T0 - 30 * MIN) });
    advance(60_000);
    expect((await engine.sweepStalled()).map((s) => s.run.id)).toEqual(['forever']);
    expect(seen).toHaveLength(2);
  });

  it('is a no-op without listeners, and a throwing listener does not break the sweep', async () => {
    const { store, engine } = harness();
    await seedRun(store, 'a', { updatedAgoMs: 20 * MIN });
    await seedRun(store, 'b', { updatedAgoMs: 20 * MIN });
    expect(await engine.sweepStalled()).toEqual([]);
    const seen: string[] = [];
    engine.onStalled(() => {
      throw new Error('pager down');
    });
    const off = engine.onStalled((info) => seen.push(info.run.id));
    // The listener-less pass did not consume the throttle.
    expect((await engine.sweepStalled()).length).toBe(2);
    expect(seen.sort()).toEqual(['a', 'b']);
    off();
  });

  it('is scoped to the engine namespace', async () => {
    const { store, engine } = harness({ namespace: 'tenant-a' });
    await seedRun(store, 'mine', { updatedAgoMs: 20 * MIN, namespace: 'tenant-a' });
    await seedRun(store, 'theirs', { updatedAgoMs: 20 * MIN, namespace: 'tenant-b' });
    const ids: string[] = [];
    engine.onStalled((info) => ids.push(info.run.id));
    await engine.sweepStalled();
    expect(ids).toEqual(['mine']);
  });

  it('honours stalledAfterMs (floored at one minute) and skips while draining', async () => {
    const { store, engine } = harness({ stalledAfterMs: 30 * MIN });
    await seedRun(store, 'forever', { updatedAgoMs: 20 * MIN });
    engine.onStalled(() => undefined);
    expect(await engine.sweepStalled()).toEqual([]);

    const floored = harness({ stalledAfterMs: 1 });
    await seedRun(floored.store, 'young', { updatedAgoMs: 30_000 });
    await seedRun(floored.store, 'old', { updatedAgoMs: 2 * MIN });
    expect((await floored.engine.listStalledRuns()).map((s) => s.run.id)).toEqual(['old']);

    const draining = harness();
    await seedRun(draining.store, 'forever', { updatedAgoMs: 20 * MIN });
    draining.engine.onStalled(() => undefined);
    draining.engine.beginDrain();
    expect(await draining.engine.sweepStalled()).toEqual([]);
  });

  it('pages through more candidates than one listRuns page', async () => {
    const { store, engine } = harness();
    for (let i = 0; i < 450; i += 1) {
      await seedRun(store, `r${i}`, { updatedAgoMs: 20 * MIN + i });
    }
    expect(await engine.listStalledRuns()).toHaveLength(450);
    expect(await engine.listStalledRuns({ scan: 100 })).toHaveLength(100);
  });
});
