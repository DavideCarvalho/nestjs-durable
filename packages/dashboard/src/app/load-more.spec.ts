import { describe, expect, it } from 'vitest';
import { type LoadMoreDecision, shouldLoadMore } from './load-more';

/** A list of 100 loaded out of 10,000, scrolled to the very last rendered row. */
const atTheEnd = (over: Partial<LoadMoreDecision> = {}): LoadMoreDecision => ({
  hasMore: true,
  loading: false,
  lastRenderedIndex: 99,
  loadedCount: 100,
  requestedAtCount: -1,
  loadAhead: 12,
  ...over,
});

describe('shouldLoadMore', () => {
  it('asks for the next page once the last rows are rendered', () => {
    expect(shouldLoadMore(atTheEnd())).toBe(true);
  });

  it('asks EARLY — within the lookahead, so the page lands before the operator hits the bottom', () => {
    // Row 87 of 100 with a 12-row lookahead is the first position that should trigger.
    expect(shouldLoadMore(atTheEnd({ lastRenderedIndex: 87 }))).toBe(true);
    expect(shouldLoadMore(atTheEnd({ lastRenderedIndex: 86 }))).toBe(false);
  });

  it('stays quiet while the operator is nowhere near the end', () => {
    expect(shouldLoadMore(atTheEnd({ lastRenderedIndex: 20 }))).toBe(false);
  });

  it('stays quiet when the list is already whole', () => {
    expect(shouldLoadMore(atTheEnd({ hasMore: false }))).toBe(false);
  });

  it('does not stack a request behind one already in flight', () => {
    // Every poll re-renders this list, and scrolling fires more of them. Without this, one flick to
    // the bottom queues a page per render.
    expect(shouldLoadMore(atTheEnd({ loading: true }))).toBe(false);
  });

  it('does not re-fire at a count it already asked at', () => {
    // The runaway guard. A control plane can report a `total` ahead of what its listing returns for a
    // moment, so the list never reaches the promised count; without this the watcher would keep
    // asking on every render and walk the page size up until the tab is unusable — the exact failure
    // paging exists to prevent.
    expect(shouldLoadMore(atTheEnd({ requestedAtCount: 100 }))).toBe(false);
  });

  it('fires again once the page actually grew', () => {
    // Same guard, one page later: 200 loaded, last request was at 100.
    expect(
      shouldLoadMore(atTheEnd({ loadedCount: 200, lastRenderedIndex: 199, requestedAtCount: 100 })),
    ).toBe(true);
  });

  it('fires on an empty-but-incomplete list, so a short first page still fills', () => {
    // The virtualiser renders nothing before it has measured anything (`-1`). With 0 loaded and more
    // to come, that has to count as "at the end" or the list would never start.
    expect(
      shouldLoadMore(atTheEnd({ loadedCount: 0, lastRenderedIndex: -1, requestedAtCount: -2 })),
    ).toBe(true);
  });
});
