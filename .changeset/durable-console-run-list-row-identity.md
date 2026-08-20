---
'@dudousxd/nestjs-durable-dashboard': patch
---

Fix the console's run list rendering with overlapping rows and gaps after a filter change

Picking a facet — an origin chip, a status, a tag — left the sidebar's run list drawn from stale row
heights: rows sat on top of each other, gaps opened between them, and the scroll height did not match
the content. It did not recover on its own.

The virtualiser was keying its size and element caches by array index while React reconciles the rows
by `run.id`. A filter change moves surviving runs to new indices without remounting their nodes, so
no measurement was ever re-attributed: index _n_ kept the height of whichever run used to sit there,
and every row offset plus the list's total height was computed from those. The same condition arises
with no filter change at all — the list polls, and a run that starts pushes every row down one index.
The virtualiser now keys by run id, so a measurement follows the row.

The list also remounts when the filters change, which starts the new result set at the top instead of
at an arbitrary offset into a set the operator has never seen, and the loaded page count is now held
against the filters it was loaded for — so re-scoping costs one request rather than two.
