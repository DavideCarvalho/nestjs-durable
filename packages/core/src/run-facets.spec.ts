import { describe, expect, it } from 'vitest';
import type { RunStatus } from './interfaces';
import { facetOrigin, mergeRunFacetRows } from './run-facets';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('facetOrigin', () => {
  it('files every spelling of "no package claims this run" under one bucket', () => {
    // A store column that defaults to '' instead of NULL would otherwise produce a second, invisible
    // unattributed bucket — and the console\'s "unknown" chip would count one while the page it opens
    // returned the other.
    expect(facetOrigin(undefined)).toBeNull();
    expect(facetOrigin(null)).toBeNull();
    expect(facetOrigin('')).toBeNull();
    expect(facetOrigin('   ')).toBeNull();
  });

  it('leaves a real package name alone, whitespace and all', () => {
    expect(facetOrigin('@dudousxd/nestjs-agent')).toBe('@dudousxd/nestjs-agent');
  });
});

describe('mergeRunFacetRows', () => {
  it('folds the blank-origin spellings into ONE cell per status', () => {
    const merged = mergeRunFacetRows([
      { status: 'failed', origin: null, count: 2 },
      { status: 'failed', origin: '', count: 3 },
      { status: 'failed', origin: undefined, count: 1 },
    ]);

    expect(merged).toEqual([{ status: 'failed', origin: null, count: 6 }]);
  });

  it('keeps distinct (status, origin) pairs apart', () => {
    const merged = mergeRunFacetRows([
      { status: 'failed', origin: 'a', count: 1 },
      { status: 'completed', origin: 'a', count: 2 },
      { status: 'failed', origin: 'b', count: 4 },
    ]);

    expect(merged).toHaveLength(3);
    expect(merged).toContainEqual({ status: 'failed', origin: 'a', count: 1 });
    expect(merged).toContainEqual({ status: 'completed', origin: 'a', count: 2 });
    expect(merged).toContainEqual({ status: 'failed', origin: 'b', count: 4 });
  });

  it('returns nothing for nothing — a zero-count cell is simply absent', () => {
    expect(mergeRunFacetRows([])).toEqual([]);
  });
});

/** A run, minimal but complete enough for the store to accept and index it. */
function run(
  id: string,
  status: RunStatus,
  extra: { origin?: string; namespace?: string; tags?: string[] } = {},
) {
  return {
    id,
    workflow: 'checkout',
    workflowVersion: '1',
    status,
    input: {},
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...extra,
  };
}

describe('InMemoryStateStore.runFacets', () => {
  const seeded = async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('a', 'completed', { origin: 'pkg-a' }));
    await store.createRun(run('b', 'completed', { origin: 'pkg-a' }));
    await store.createRun(run('c', 'failed', { origin: 'pkg-b' }));
    await store.createRun(run('d', 'failed'));
    await store.createRun(run('e', 'failed', { origin: '  ' }));
    return store;
  };

  it('counts every (status, origin) cell over the whole set, not a page', async () => {
    const store = await seeded();

    const facets = await store.runFacets({});

    expect(facets).toContainEqual({ status: 'completed', origin: 'pkg-a', count: 2 });
    expect(facets).toContainEqual({ status: 'failed', origin: 'pkg-b', count: 1 });
    // The absent origin and the whitespace one are the SAME bucket.
    expect(facets).toContainEqual({ status: 'failed', origin: null, count: 2 });
  });

  it('is unaffected by the paging that bounds the listing beside it', async () => {
    // This is the whole point: `listRuns` returns a page, the chips above it still report the set.
    const store = await seeded();

    const page = await store.listRuns({ limit: 1 });
    const facets = await store.runFacets({});

    expect(page).toHaveLength(1);
    expect(facets.reduce((n, f) => n + f.count, 0)).toBe(5);
  });

  it('narrows on the predicates it is given', async () => {
    const store = await seeded();
    await store.createRun(run('f', 'completed', { origin: 'pkg-a', namespace: 'acme' }));

    const facets = await store.runFacets({ namespace: 'acme' });

    expect(facets).toEqual([{ status: 'completed', origin: 'pkg-a', count: 1 }]);
  });
});

describe('InMemoryStateStore.listRuns: the unattributed bucket', () => {
  it('selects runs with NO origin when `origin` is null, which no VALUE can match', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('a', 'failed', { origin: 'pkg-a' }));
    await store.createRun(run('b', 'failed'));

    const unattributed = await store.listRuns({ origin: null });

    expect(unattributed.map((r) => r.id)).toEqual(['b']);
  });

  it('still treats an origin VALUE as an exact match', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(run('a', 'failed', { origin: 'pkg-a' }));
    await store.createRun(run('b', 'failed'));

    const attributed = await store.listRuns({ origin: 'pkg-a' });

    expect(attributed.map((r) => r.id)).toEqual(['a']);
  });
});
