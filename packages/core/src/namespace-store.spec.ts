import { describe, expect, it } from 'vitest';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const now = new Date('2026-06-26T00:00:00.000Z');
const base = { workflow: 'w', workflowVersion: '1', input: {}, createdAt: now, updatedAt: now };

describe('InMemoryStateStore namespace filtering', () => {
  it('listPendingRuns filters by namespace, and no-arg returns all (back-compat)', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...base, id: 'a', status: 'pending', namespace: 'alpha' });
    await store.createRun({ ...base, id: 'b', status: 'pending', namespace: 'beta' });
    await store.createRun({ ...base, id: 'c', status: 'pending' }); // legacy, no namespace

    expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a']);
    expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('listIncompleteRuns and listDueTimers filter by namespace', async () => {
    const store = new InMemoryStateStore();
    await store.createRun({ ...base, id: 'r', status: 'running', namespace: 'alpha' });
    await store.createRun({ ...base, id: 's', status: 'running', namespace: 'beta' });
    await store.createRun({
      ...base,
      id: 't',
      status: 'suspended',
      namespace: 'alpha',
      wakeAt: now.getTime() - 1,
    });
    await store.createRun({
      ...base,
      id: 'u',
      status: 'suspended',
      namespace: 'beta',
      wakeAt: now.getTime() - 1,
    });

    expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['r']);
    expect((await store.listDueTimers(now.getTime(), 'alpha')).map((r) => r.id)).toEqual(['t']);
  });
});
