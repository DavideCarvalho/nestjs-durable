import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

function run(id: string, createdAt: Date, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe('listRuns ordering', () => {
  it('returns runs newest-first (most recent createdAt on top)', async () => {
    const store = new InMemoryStateStore();
    // Insert oldest-first, so a passing test proves the order comes from createdAt, not insertion.
    await store.createRun(run('old', new Date('2026-01-01T00:00:00Z')));
    await store.createRun(run('mid', new Date('2026-02-01T00:00:00Z')));
    await store.createRun(run('new', new Date('2026-03-01T00:00:00Z')));

    const runs = await store.listRuns({});
    expect(runs.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('listRuns workflow filter', () => {
  it('returns only runs of the named workflow', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('a', new Date('2026-01-01T00:00:00Z'), { workflow: 'pribuy' }));
    await store.createRun(run('b', new Date('2026-02-01T00:00:00Z'), { workflow: 'checkout' }));
    await store.createRun(run('c', new Date('2026-03-01T00:00:00Z'), { workflow: 'pribuy' }));

    const runs = await store.listRuns({ workflow: 'pribuy' });
    // Newest-first within the matching workflow; `checkout` is excluded entirely.
    expect(runs.map((r) => r.id)).toEqual(['c', 'a']);
    expect(runs.every((r) => r.workflow === 'pribuy')).toBe(true);
  });

  it('combines the workflow filter with status (both must hold)', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(
      run('p-done', new Date('2026-01-01T00:00:00Z'), {
        workflow: 'pribuy',
        status: 'completed',
      }),
    );
    await store.createRun(
      run('p-running', new Date('2026-02-01T00:00:00Z'), {
        workflow: 'pribuy',
        status: 'running',
      }),
    );
    await store.createRun(
      run('c-running', new Date('2026-03-01T00:00:00Z'), {
        workflow: 'checkout',
        status: 'running',
      }),
    );

    const runs = await store.listRuns({ workflow: 'pribuy', status: 'running' });
    expect(runs.map((r) => r.id)).toEqual(['p-running']);
  });

  it('returns an empty list when no run matches the workflow name', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('a', new Date('2026-01-01T00:00:00Z'), { workflow: 'checkout' }));

    const runs = await store.listRuns({ workflow: 'pribuy' });
    expect(runs).toEqual([]);
  });
});
