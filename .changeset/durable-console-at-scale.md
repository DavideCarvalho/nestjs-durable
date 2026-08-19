---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-testing': minor
---

The console stays responsive on a control plane with tens of thousands of runs

Measured against a live deployment holding 9,533 runs, the console was unusable: `GET /runs` returned
**12.24 MB** (uncompressed) every 3 seconds, the run list mounted **115,636 DOM nodes**, and the tab
spent **26.9 of every 30 seconds** with its main thread blocked — a 16-second freeze on open, then
~4 seconds on every poll. Opening a long run (488 checkpoints) blocked it for another 21 seconds.
The same measurements now read **0.24 s** and **0 ms of steady-state freeze**.

What changed:

- **The run list is a page.** `GET runs` accepts `limit`/`offset` (every store already implemented
  them; the console simply never sent them) and the SPA fetches 100 rows, virtualised so only the
  visible ones are mounted, with "show more" to go further back.
- **New `runs/facets` endpoint**, backed by `StateStore.runFacets` / `RunGateway.runFacets` — one
  `GROUP BY status, origin` aggregate. This is what makes paging safe: the page bounds what is
  rendered, the status and origin chips still report the whole matching set.
- **`RunQuery.origin` accepts `null`** to select runs carrying no origin (`origin IS NULL`). The
  console's "unknown" facet used to be applied in the browser precisely because an exact-match filter
  cannot express absence, which meant it needed every run in memory to work. It is now a server-side
  predicate, on the list and on bulk actions alike.
- **The list endpoint returns rows, not runs.** `input`, `output` and `error` are omitted — on the
  deployment measured, `error` alone (a stack trace per failed run) was 63% of the payload, and no
  list row reads any of the three. `GET runs/:id` is unchanged.
- **`GET runs` accepts a repeated `status` param** (`?status=running&status=suspended`), ORed into
  `RunQuery.statuses`. A single value still narrows to that status exactly as before.
- **The detail pane no longer re-lays-out a run on every poll.** It, the workflow graph and the span
  timeline are memoised, the graph culls off-screen nodes, and the run detail's own sibling lookup
  went from listing every run every 3 seconds to a bounded query issued only for singleton runs.
- **The "no live worker" banner reads worker health** rather than the runs on screen, so it cannot go
  quiet just because the stalled runs fell off the page.

Nothing is required of consumers: absent `limit`/`offset` still returns the whole listing, and
`runFacets` is optional on `StateStore` (a store without it falls back to counting a listing).
`RunGateway` implementors must add `runFacets`.
