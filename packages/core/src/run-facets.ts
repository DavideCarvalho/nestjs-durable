import type { RunFacetRow, RunStatus } from './interfaces';

/**
 * The origin a facet cell is filed under. An origin that is absent, null, or blank is all the same
 * thing to an operator — a run no package claims — so they collapse to `null` here. Without this the
 * "unknown" chip would count only one of those spellings while `origin IS NULL` paging returned
 * another, and the chip's number would not match the page it opens.
 */
export function facetOrigin(origin: string | null | undefined): string | null {
  return origin?.trim() ? origin : null;
}

/**
 * Fold `(status, origin)` counts into one cell per pair, normalising origins via {@link facetOrigin}.
 * Store adapters group in SQL and pipe their rows through this, so every adapter — and the in-memory
 * store the tests run against — agrees on what lands in the unattributed bucket instead of each
 * collapsing blanks its own way.
 */
export function mergeRunFacetRows(
  rows: readonly { status: RunStatus; origin: string | null | undefined; count: number }[],
): RunFacetRow[] {
  const cells = new Map<string, RunFacetRow>();
  for (const row of rows) {
    const origin = facetOrigin(row.origin);
    const key = JSON.stringify([row.status, origin]);
    const cell = cells.get(key);
    if (cell) cell.count += row.count;
    else cells.set(key, { status: row.status, origin, count: row.count });
  }
  return [...cells.values()];
}
