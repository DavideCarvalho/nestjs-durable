/**
 * When an infinite-scrolling list should ask for its next page.
 *
 * Pulled out of the component because the decision has four ways to be wrong and none of them are
 * reachable from a rendered test: a virtualiser measures real element heights, and a DOM with no
 * layout reports every row as zero-high, so `getVirtualItems()` there tells you nothing about what an
 * operator can actually see.
 */
export interface LoadMoreDecision {
  /** Whether the server has runs beyond the ones already loaded. */
  hasMore: boolean;
  /** Whether a fetch is already in flight. */
  loading: boolean;
  /** Index of the last row the virtualiser has rendered; `-1` when it has rendered none. */
  lastRenderedIndex: number;
  /** How many rows are loaded right now. */
  loadedCount: number;
  /** The `loadedCount` the previous request was fired at — see the third rule below. */
  requestedAtCount: number;
  /** How many rows from the end to start loading. */
  loadAhead: number;
}

/**
 * Four rules, and the third is the one that is easy to miss:
 *
 * 1. Nothing more to fetch — stop.
 * 2. A fetch is in flight — a scroll must not stack requests behind it.
 * 3. A request already went out at this exact loaded count. A control plane's `total` can sit ahead
 *    of what its listing returns for a moment (a run settles between the count query and the page
 *    query), and then the list never reaches the promised total — so without this the watcher re-fires
 *    on every render, forever, walking the page size up until the tab is unusable again. Which is the
 *    failure the paging exists to prevent.
 * 4. The last rendered row is still far from the end — the operator has not scrolled near it yet.
 */
export function shouldLoadMore(d: LoadMoreDecision): boolean {
  if (!d.hasMore) return false;
  if (d.loading) return false;
  if (d.requestedAtCount === d.loadedCount) return false;
  return d.lastRenderedIndex >= d.loadedCount - 1 - d.loadAhead;
}
