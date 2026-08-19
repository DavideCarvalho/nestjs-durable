---
'@dudousxd/nestjs-durable-dashboard': minor
---

The console's run list scrolls infinitely instead of asking for the next page

The paged list landed with a **show more** button. Scrolling is what an operator is already doing to
reach the bottom of it, so the button was a second thing to do at the moment the intent was already
unambiguous. The page now extends itself as the last rows come into view, and the footer says
`N of TOTAL` with `loading…` while the next one is in flight.

The load starts a lookahead (12 rows) before the bottom, so the list reads as continuous rather than
stalling at every page boundary. It is driven off the virtualiser's rendered range rather than a
scroll handler or a sentinel element — the virtualiser is the only thing that knows which rows are
on screen while they are still being measured.

Two guards, and the second is the one that matters: a request is never stacked behind one already in
flight, and never re-fired at a loaded count it already fired at. A control plane's `total` can sit
ahead of what its listing returns for a moment — a run settling between the count query and the page
query — and then the list never reaches the promised count. Without that guard the watcher re-fires on
every render and walks the page size up until the tab is unusable again, which is the exact failure
the paging exists to prevent. `shouldLoadMore` is a pure function with a spec covering both, because
a virtualiser measures real element heights and a DOM with no layout reports every row as zero-high.

Measured on the scale harness (10,000 runs, 4x CPU throttle): scrolling grows the list 100 → 500 with
no button; left alone it stays at 100 through 13 polls over 30s; and at 1,000 rows loaded the steady
state is 0 ms of blocked main thread, 25 rows mounted, 462 DOM nodes.
