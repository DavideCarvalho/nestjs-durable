import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from './interfaces';
import { mergeRunValueFacetRows, runValueFacetsFromRuns } from './run-value-facets';

const run = (over: Partial<WorkflowRun>): WorkflowRun =>
  ({
    id: 'r',
    workflow: 'w',
    status: 'completed',
    createdAt: new Date(),
    updatedAt: new Date(),
    input: {},
    ...over,
  }) as WorkflowRun;

describe('run value facets', () => {
  it('orders by count, then alphabetically, and bounds the answer', () => {
    expect(
      mergeRunValueFacetRows(
        [
          { value: 'b', count: 1 },
          { value: 'a', count: 3 },
          { value: 'c', count: 1 },
        ],
        { limit: 2 },
      ),
    ).toEqual([
      { value: 'a', count: 3 },
      { value: 'b', count: 1 },
    ]);
  });

  it('ranks engine-minted per-key tags after everything else, however common', () => {
    // Measured on a real control plane, 82 of the top 100 tags were `singleton:*`, which pushed
    // genuine tags off the list entirely. They stay offered — just last.
    expect(
      mergeRunValueFacetRows([
        { value: 'singleton:catalog:abc', count: 900 },
        { value: 'type:mvr', count: 20 },
        { value: 'singleton:catalog:def', count: 800 },
      ]),
    ).toEqual([
      { value: 'type:mvr', count: 20 },
      { value: 'singleton:catalog:abc', count: 900 },
      { value: 'singleton:catalog:def', count: 800 },
    ]);
  });

  it('keeps a bounded engine tag competing fairly', () => {
    // `version:undeclared` is engine-minted too, but there is exactly ONE of it — it is a real
    // filter an operator would pick, not per-key bookkeeping.
    expect(
      mergeRunValueFacetRows([
        { value: 'version:undeclared', count: 23 },
        { value: 'etl', count: 5 },
      ]),
    ).toEqual([
      { value: 'version:undeclared', count: 23 },
      { value: 'etl', count: 5 },
    ]);
  });

  it('searches before it bounds, so a rare value is reachable', () => {
    // The search box exists precisely because the list was cut to fit. Filtering the already-cut
    // page would make the values it was cut from unfindable — searchable only among what survived.
    expect(
      mergeRunValueFacetRows(
        [
          { value: 'type:mvr', count: 2 },
          { value: 'etl', count: 900 },
          { value: 'type:mel', count: 1 },
        ],
        { search: 'type:', limit: 1 },
      ),
    ).toEqual([{ value: 'type:mvr', count: 2 }]);
  });

  it('pages a stable order, so page two continues page one', () => {
    const rows = [
      { value: 'a', count: 3 },
      { value: 'b', count: 2 },
      { value: 'c', count: 1 },
    ];

    expect(mergeRunValueFacetRows(rows, { limit: 2 })).toEqual([
      { value: 'a', count: 3 },
      { value: 'b', count: 2 },
    ]);
    expect(mergeRunValueFacetRows(rows, { limit: 2, offset: 2 })).toEqual([
      { value: 'c', count: 1 },
    ]);
  });

  it('counts the axes a run carries', () => {
    const runs = [
      run({ tags: ['etl'], searchAttributes: { tier: 'pro' }, namespace: 'acme' }),
      run({ tags: ['etl', 'nightly'], searchAttributes: { tier: 'free' }, namespace: 'acme' }),
    ];

    expect(runValueFacetsFromRuns(runs, { field: 'tag' })).toEqual([
      { value: 'etl', count: 2 },
      { value: 'nightly', count: 1 },
    ]);
    expect(runValueFacetsFromRuns(runs, { field: 'attributeKey' })).toEqual([
      { value: 'tier', count: 2 },
    ]);
    expect(
      runValueFacetsFromRuns(runs, { field: 'attributeValue', key: 'tier' }).map((r) => r.value),
    ).toEqual(['free', 'pro']);
    expect(runValueFacetsFromRuns(runs, { field: 'namespace' })).toEqual([
      { value: 'acme', count: 2 },
    ]);
  });
});
