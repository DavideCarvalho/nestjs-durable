import { describe, expect, it } from 'vitest';
import type { GroupHealth, WorkerHeartbeat } from './durable-client.js';
import { stalledWorkflows, summarizeHealth } from './summarize-health.js';

function worker(over: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return { group: '', instanceId: 'w1', lastBeatAt: 0, ...over };
}

function group(over: Partial<GroupHealth> = {}): GroupHealth {
  return { group: 'g', depth: 0, liveWorkers: [], ...over };
}

describe('summarizeHealth', () => {
  it('all-healthy input: allDraining true, starved empty, correct counts', () => {
    const summary = summarizeHealth([
      group({ group: 'a', depth: 3, liveWorkers: [worker({ instanceId: 'w1', group: 'a' })] }),
      group({ group: 'b', depth: 0, liveWorkers: [worker({ instanceId: 'w2', group: 'b' })] }),
    ]);
    expect(summary.allDraining).toBe(true);
    expect(summary.starved).toEqual([]);
    expect(summary.queueCount).toBe(2);
    expect(summary.workerCount).toBe(2);
  });

  it('a depth>0, 0-workers group appears in starved', () => {
    const starvedGroup = group({ group: 'a', depth: 5, liveWorkers: [] });
    const summary = summarizeHealth([starvedGroup]);
    expect(summary.starved).toEqual([starvedGroup]);
    expect(summary.allDraining).toBe(false);
  });

  it('a depth>0 group with workers is NOT starved', () => {
    const summary = summarizeHealth([
      group({ group: 'a', depth: 5, liveWorkers: [worker({ instanceId: 'w1', group: 'a' })] }),
    ]);
    expect(summary.starved).toEqual([]);
    expect(summary.allDraining).toBe(true);
  });

  it('starved is sorted by depth descending', () => {
    const low = group({ group: 'low', depth: 1, liveWorkers: [] });
    const high = group({ group: 'high', depth: 9, liveWorkers: [] });
    const mid = group({ group: 'mid', depth: 4, liveWorkers: [] });
    const summary = summarizeHealth([low, high, mid]);
    expect(summary.starved.map((g) => g.group)).toEqual(['high', 'mid', 'low']);
  });

  it('workerCount dedupes an instanceId that serves multiple queues', () => {
    const summary = summarizeHealth([
      group({ group: 'a', depth: 0, liveWorkers: [worker({ instanceId: 'shared', group: 'a' })] }),
      group({ group: 'b', depth: 0, liveWorkers: [worker({ instanceId: 'shared', group: 'b' })] }),
    ]);
    expect(summary.workerCount).toBe(1);
  });

  it('empty input returns the documented zero value', () => {
    expect(summarizeHealth([])).toEqual({
      queueCount: 0,
      workflowCount: 0,
      stepCount: 0,
      workerCount: 0,
      starved: [],
      allDraining: true,
    });
  });

  it('counts distinct workflows vs steps by kind, deduped by base name across partitions', () => {
    const summary = summarizeHealth([
      // same workflow served on two partitions → ONE workflow
      group({ group: 'pipeline@davi-local', kind: 'workflow' }),
      group({ group: 'pipeline@default', kind: 'workflow' }),
      group({ group: 'processing', kind: 'workflow' }),
      // steps
      group({ group: 'PipelineWorkflow.bustBaseCache', kind: 'step' }),
      group({ group: 'handle_mel_dep_procs', kind: 'step' }),
      // unclassified (kind absent) counts toward neither bucket
      group({ group: 'mystery' }),
    ]);
    expect(summary.workflowCount).toBe(2);
    expect(summary.stepCount).toBe(2);
    expect(summary.queueCount).toBe(6);
  });
});

describe('stalledWorkflows', () => {
  const group = (
    name: string,
    kind: 'workflow' | 'step',
    depth: number,
    workers: number,
  ): GroupHealth => ({
    group: name,
    kind,
    depth,
    liveWorkers: Array.from({ length: workers }, (_, i) => ({
      group: name,
      instanceId: `w${i}`,
      lastBeatAt: 0,
    })),
  });

  it('names a workflow queue with backlog and nobody consuming it', () => {
    expect(stalledWorkflows([group('ingestion', 'workflow', 4, 0)])).toEqual(['ingestion']);
  });

  it('stays quiet for a queue that has a worker, however deep the backlog', () => {
    expect(stalledWorkflows([group('ingestion', 'workflow', 400, 1)])).toEqual([]);
  });

  it('stays quiet for an IDLE queue — no backlog is not the same as blocked', () => {
    // A suspended run parked on its reconcile timer has no live worker and nothing enqueued. Calling
    // that "no worker" is the false positive `deriveRunState` is careful to avoid.
    expect(stalledWorkflows([group('ingestion', 'workflow', 0, 0)])).toEqual([]);
  });

  it('aggregates a workflow across its per-tenant partitions', () => {
    // Queues are `<name>@<tenant>`; a worker on ANY partition means the workflow is being served.
    expect(
      stalledWorkflows([
        group('ingestion@acme', 'workflow', 4, 0),
        group('ingestion@globex', 'workflow', 0, 1),
      ]),
    ).toEqual([]);
  });

  it('ignores step queues — the banner is about workflows', () => {
    expect(stalledWorkflows([group('extract', 'step', 9, 0)])).toEqual([]);
  });

  it('reads worker health alone, so it survives the run list being a page', () => {
    // The banner used to be derived from the runs on screen. Now the list is paged, that would have
    // gone quiet the moment the stalled runs scrolled past the page boundary — which is exactly when
    // an operator most needs to see it.
    expect(stalledWorkflows([group('a', 'workflow', 1, 0), group('b', 'workflow', 2, 0)])).toEqual([
      'a',
      'b',
    ]);
  });
});
