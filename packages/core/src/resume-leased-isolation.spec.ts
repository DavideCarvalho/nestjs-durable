import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A batch of leased runs is a mixed bag, and skew protection guarantees it: mid-rolling-deploy a pod
 * holds some workflows and not others, so `resume` throws for the ones it does not have. Ending the
 * loop there means one row stops recovery for every run behind it — and, since every caller is a
 * recovery sweep on a poller, sends the rejection into a Nest lifecycle hook.
 */

/** Pending run rows, `ghost` first so the batch fails on its very first entry. */
async function twoPendingRuns(store: InMemoryStateStore) {
  await store.createRun({
    id: 'ghost-run',
    workflow: 'ghost',
    workflowVersion: '1',
    status: 'pending',
    input: {},
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
  await store.createRun({
    id: 'known-run',
    workflow: 'known',
    workflowVersion: '1',
    status: 'pending',
    input: {},
    createdAt: new Date(2),
    updatedAt: new Date(2),
  });
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

describe('resumeLeased', () => {
  it('runs the rest of the batch when one run cannot be resumed', async () => {
    const store = new InMemoryStateStore();
    await twoPendingRuns(store);
    const engine = new WorkflowEngine({ store });
    engine.register('known', '1', async () => 'done');

    await expect(engine.runPending()).resolves.toBeDefined();

    // `ghost` has no registration here and no transport to reach one by convention, so it is left
    // alone — for a pod that does have it, which is what the skew-protection error asks for.
    expect((await store.getRun('ghost-run'))?.status).toBe('pending');
    expect((await store.getRun('known-run'))?.status).toBe('completed');
  });

  it('reports the run it skipped, naming the version that was missing', async () => {
    // A skip is not nothing — the run is still there and still not progressing. Without this the
    // symptom is a run stuck in `pending` with no explanation anywhere.
    const store = new InMemoryStateStore();
    await twoPendingRuns(store);
    const engine = new WorkflowEngine({ store });
    engine.register('known', '1', async () => 'done');

    await engine.runPending();

    const reported = errors.flat().map(String).join(' ');
    expect(reported).toContain('ghost-run');
    expect(reported).toContain('ghost@1');
  });

  it('stays silent when every run in the batch resumes', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({
      id: 'known-run',
      workflow: 'known',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    const engine = new WorkflowEngine({ store });
    engine.register('known', '1', async () => 'done');

    await engine.runPending();

    expect(errors).toEqual([]);
    expect((await store.getRun('known-run'))?.status).toBe('completed');
  });
});
