---
'@dudousxd/nestjs-durable-telescope': patch
---

Give the Workers table the full width of its row instead of half the viewport.

The "Workers" section declared `cols: 2` and held exactly one panel — the eleven-column worker
table, the widest on the dashboard. A section renders as a fixed `grid-cols-N` grid, one panel per
cell, with no `colSpan`, so that table got a 575px cell on a 1418px viewport, scrolled sideways
inside its own card, and left the cell beside it empty. `cols: 1` gives it the whole row.

A new spec asserts the invariant for **every** section, not just this one: a panel count that is
not an exact multiple of `cols` leaves a visible hole beside the last row, and it now fails the
build with the offending section named.
