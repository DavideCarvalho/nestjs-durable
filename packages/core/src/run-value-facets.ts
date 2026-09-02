import type {
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  WorkflowRun,
} from './interfaces';
import { facetOrigin } from './run-facets';

/** Rows a value picker gets when the caller names no bound — enough to fill a dropdown several times
 *  over, small enough that an axis with unbounded cardinality (tags) can't return a listing. */
export const RUN_VALUE_FACET_LIMIT = 100;

/** Runs read when an axis has to be counted in-process (see {@link RunValueFacetOptions.scan}). */
export const RUN_VALUE_FACET_SCAN = 5000;

/**
 * Is this axis a plain column on the runs table, and so countable with a `GROUP BY` over the whole
 * matching set?
 *
 * The other three are not, in the same way for the same reason — the value isn't in a column of the
 * row being counted. A run's tags live inside ONE json array column that no `GROUP BY` portable
 * across sqlite/MySQL/Postgres reaches into, and its search attributes live in a side table whose
 * join back to the filtered run set differs per adapter. Those axes are counted in-process over a
 * bounded scan instead ({@link runValueFacetsFromRuns}), so their counts describe that window rather
 * than the whole store — which is why {@link RunValueFacetOptions.scan} exists.
 */
export function axisIsRunColumn(
  axis: RunValueAxis,
): axis is { field: 'workflow' | 'status' | 'origin' | 'namespace' } {
  return (
    axis.field === 'workflow' ||
    axis.field === 'status' ||
    axis.field === 'origin' ||
    axis.field === 'namespace'
  );
}

/** The values one run contributes to an axis — several for `tag` (a run carries a set), one for the
 *  column axes, and none when the run has nothing on that axis (an absent search-attribute key). */
function valuesOf(run: WorkflowRun, axis: RunValueAxis): Array<string | null> {
  switch (axis.field) {
    case 'workflow':
      return [run.workflow];
    case 'status':
      return [run.status];
    case 'origin':
      return [facetOrigin(run.origin)];
    case 'namespace':
      return run.namespace === undefined ? [] : [run.namespace];
    case 'tag':
      return run.tags ?? [];
    case 'attributeKey':
      return Object.keys(run.searchAttributes ?? {});
    case 'attributeValue': {
      const value = run.searchAttributes?.[axis.key];
      return value === undefined ? [] : [String(value)];
    }
  }
}

/**
 * Fold, order and bound raw `(value, count)` rows into the answer callers see: highest count first,
 * ties broken alphabetically so a picker's order is stable between polls, the unattributed bucket
 * (`null`) last, and no more than `limit` rows.
 *
 * Every store pipes its `GROUP BY` through this — the same role {@link mergeRunFacetRows} plays for
 * status/origin counts — so a picker lists the same values in the same order whichever adapter is
 * underneath, rather than each SQL dialect's default ordering leaking into the UI.
 */
export function mergeRunValueFacetRows(
  rows: readonly { value: string | null | undefined; count: number }[],
  opts?: RunValueFacetOptions,
): RunValueFacetRow[] {
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    const value = row.value ?? null;
    counts.set(value, (counts.get(value) ?? 0) + Number(row.count));
  }
  const merged = [...counts]
    .map(([value, count]) => ({ value, count }))
    .filter((row) => row.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return a.value.localeCompare(b.value);
    });
  return merged.slice(0, opts?.limit ?? RUN_VALUE_FACET_LIMIT);
}

/**
 * Count an axis's distinct values across runs already narrowed by the caller's predicates — the
 * in-process path, used by the in-memory store for every axis and by the SQL stores for `tag` (see
 * {@link axisIsGroupable}). `runs` must be ordered newest-first and already bounded to
 * {@link RunValueFacetOptions.scan}, since that window is what the counts then describe.
 */
export function runValueFacetsFromRuns(
  runs: readonly WorkflowRun[],
  axis: RunValueAxis,
  opts?: RunValueFacetOptions,
): RunValueFacetRow[] {
  const rows: { value: string | null; count: number }[] = [];
  for (const run of runs) {
    for (const value of valuesOf(run, axis)) rows.push({ value, count: 1 });
  }
  return mergeRunValueFacetRows(rows, opts);
}
