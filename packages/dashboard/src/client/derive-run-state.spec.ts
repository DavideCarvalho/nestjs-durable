import { describe, expect, it } from 'vitest';
import {
  type GroupHealth,
  type StepCheckpoint,
  type WorkflowRun,
  baseGroup,
  deriveRunState,
  singletonLeader,
} from './durable-client';

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'pipeline',
    workflowVersion: '1',
    status: 'suspended',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function step(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'render',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** A `GroupHealth` for `group` with `live` live workers and `depth` queued jobs. `depth > 0 && live
 *  === 0` is the STALLED alert case (backlog, no consumer); `depth === 0 && live === 0` is an IDLE
 *  group (no work, no heartbeat) — not blocked, so NOT no-worker. */
function health(group: string, live = 0, depth = 0): GroupHealth {
  return {
    group,
    depth,
    liveWorkers: Array.from({ length: live }, (_, i) => ({
      group,
      instanceId: `w${i}`,
      lastBeatAt: 0,
    })),
  };
}

describe('baseGroup', () => {
  it('strips the route-by-handler @partition suffix', () => {
    expect(baseGroup('pipeline@davi-local')).toBe('pipeline');
    expect(baseGroup('pipeline')).toBe('pipeline');
    expect(baseGroup('extraction:page@t1')).toBe('extraction:page');
  });
});

describe('singletonLeader', () => {
  const tag = 'singleton:base:1';

  it('is undefined for a run with no singleton tag', () => {
    expect(singletonLeader(run(), [run()])).toBeUndefined();
  });

  it('picks the oldest in-flight run sharing the key by (createdAt, id)', () => {
    const older = run({ id: 'a', tags: [tag], createdAt: '2026-01-01T00:00:00Z' });
    const newer = run({ id: 'b', tags: [tag], createdAt: '2026-01-01T00:05:00Z' });
    expect(singletonLeader(newer, [newer, older])?.id).toBe('a');
  });

  it('ignores terminal siblings (only running/suspended/cancelling hold a slot)', () => {
    const done = run({
      id: 'a',
      tags: [tag],
      status: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const live = run({
      id: 'b',
      tags: [tag],
      status: 'suspended',
      createdAt: '2026-01-01T00:05:00Z',
    });
    expect(singletonLeader(live, [done, live])?.id).toBe('b');
  });
});

describe('deriveRunState', () => {
  const withWorker = [health('pipeline', 1)];
  // STALLED: a backlog (depth > 0) with no live worker — the genuine "no worker" alert case.
  const stalled = [health('pipeline', 0, 1)];
  // IDLE: no backlog and no live worker — a parked/settled run, NOT blocked.
  const idle = [health('pipeline', 0, 0)];

  it('passes a non-suspended, non-pending status through', () => {
    expect(
      deriveRunState(run({ status: 'completed' }), { runs: [], health: withWorker }).status,
    ).toBe('completed');
  });

  it('names an event wait: signal / webhook / child', () => {
    const s = deriveRunState(run({ waiting: { on: 'signal', name: 'approve' } }), {
      runs: [],
      health: withWorker,
    });
    expect(s.status).toBe('awaiting');
    expect(s.detail).toBe('signal approve');

    expect(
      deriveRunState(run({ waiting: { on: 'webhook', name: 'wh:r1:0' } }), {
        runs: [],
        health: withWorker,
      }).detail,
    ).toBe('webhook wh:r1:0');
    expect(
      deriveRunState(run({ waiting: { on: 'child', name: 'kid-7' } }), {
        runs: [],
        health: withWorker,
      }).detail,
    ).toBe('child kid-7');
  });

  it('flags a suspended run whose workflow queue is stalled (backlog, no consumer) as no-worker', () => {
    const s = deriveRunState(run(), { runs: [], health: stalled });
    expect(s.status).toBe('no-worker');
    expect(s.detail).toBe('pipeline');
  });

  it('does NOT flag an idle suspended run (no backlog, no live worker) — it reads running, not no-worker', () => {
    // The false positive we fixed: a settled/parked run whose group is simply idle (no heartbeat, but
    // nothing enqueued) must not be mislabelled "no worker".
    expect(deriveRunState(run(), { runs: [], health: idle }).status).toBe('running');
  });

  it('does NOT flag a suspended run whose workflow group is absent from health (no backlog to stall)', () => {
    expect(deriveRunState(run(), { runs: [], health: [] }).status).toBe('running');
  });

  it('shows a suspended run with a live worker (and no event wait) as running', () => {
    expect(deriveRunState(run(), { runs: [], health: withWorker }).status).toBe('running');
  });

  it('shows a run queued behind its singleton leader, and the leader itself as running', () => {
    const tag = 'singleton:base:1';
    const leader = run({ id: 'a', tags: [tag], createdAt: '2026-01-01T00:00:00Z' });
    const queued = run({ id: 'b1234567cd', tags: [tag], createdAt: '2026-01-01T00:05:00Z' });
    const runs = [leader, queued];
    expect(deriveRunState(leader, { runs, health: withWorker }).status).toBe('running');
    const q = deriveRunState(queued, { runs, health: withWorker });
    expect(q.status).toBe('queued');
    expect(q.detail).toBe('behind leader a');
  });

  it('singleton-queued takes precedence over no-worker', () => {
    const tag = 'singleton:base:1';
    const leader = run({ id: 'a', tags: [tag], createdAt: '2026-01-01T00:00:00Z' });
    const queued = run({ id: 'b', tags: [tag], createdAt: '2026-01-01T00:05:00Z' });
    expect(deriveRunState(queued, { runs: [leader, queued], health: stalled }).status).toBe(
      'queued',
    );
  });

  it('an event wait takes precedence over no-worker (a signal needs no worker)', () => {
    const s = deriveRunState(run({ waiting: { on: 'signal', name: 'go' } }), {
      runs: [],
      health: stalled,
    });
    expect(s.status).toBe('awaiting');
  });

  it('flags a pending run whose queue is stalled as no-worker; idle or worked, it stays pending', () => {
    expect(deriveRunState(run({ status: 'pending' }), { runs: [], health: stalled }).status).toBe(
      'no-worker',
    );
    expect(deriveRunState(run({ status: 'pending' }), { runs: [], health: idle }).status).toBe(
      'pending',
    );
    expect(
      deriveRunState(run({ status: 'pending' }), { runs: [], health: withWorker }).status,
    ).toBe('pending');
  });

  it('matches the workflow against the health group base token (ignoring @partition)', () => {
    expect(
      deriveRunState(run(), { runs: [], health: [health('pipeline@davi-local', 1)] }).status,
    ).toBe('running');
  });

  // The detail view passes `timeline` — it must AGREE with the list row for the same run.
  describe('with a timeline (detail view)', () => {
    it('a settled step, nothing pending, stalled workflow queue reads no-worker (matches the list)', () => {
      const timeline = [step({ name: 'render', status: 'completed' })];
      expect(deriveRunState(run(), { runs: [], health: stalled, timeline }).status).toBe(
        'no-worker',
      );
    });

    it('a settled step, nothing pending, idle workflow queue reads running — not a false no-worker', () => {
      const timeline = [step({ name: 'render', status: 'completed' })];
      expect(deriveRunState(run(), { runs: [], health: idle, timeline }).status).toBe('running');
    });

    it('a step in flight reads running when its group has a worker, no-worker when its group is stalled', () => {
      const inflight = [step({ name: 'render', status: 'pending', workerGroup: 'render' })];
      expect(
        deriveRunState(run(), { runs: [], health: [health('render', 1)], timeline: inflight })
          .status,
      ).toBe('running');
      expect(
        deriveRunState(run(), { runs: [], health: [health('render', 0, 1)], timeline: inflight })
          .status,
      ).toBe('no-worker');
    });

    it('a pending signal checkpoint reads awaiting, naming it the same way the list does', () => {
      const timeline = [step({ kind: 'signal', name: 'wh:r1:0', status: 'pending' })];
      const s = deriveRunState(run(), { runs: [], health: stalled, timeline });
      expect(s.status).toBe('awaiting');
      expect(s.detail).toBe('webhook wh:r1:0');
    });

    it('a pending sleep checkpoint reads sleeping', () => {
      const timeline = [step({ kind: 'sleep', name: 'sleep', status: 'pending' })];
      expect(deriveRunState(run(), { runs: [], health: withWorker, timeline }).status).toBe(
        'sleeping',
      );
    });
  });
});
