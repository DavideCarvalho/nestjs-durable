---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

The console handles runs with wide fans. For a 40,000-member fan, a run's detail was a 19MB payload, re-fetched every 1.5s and on every live event. An in-flight child fan also fetched one detail per child, twice, and the view rendered a row, a graph node and a header chip per member.

- **Summarized detail.** `RunGateway.getRunDetail(runId, { summarizeFansOver })` returns each fan wider than that as one `FanSummary` instead of its members:
  - the summary carries the label, size, counts per status (a failed child counts as failed, a folded checkpoint as the children it stands for), the time span and the first 20 failures;
  - `children` is capped at 200, with `childCount` carrying the real total;
  - the option is unset by default, so existing callers keep the full timeline.
- **Fan pages.** The new optional `RunGateway.getFanMembers(runId, group, { offset, limit, failedOnly })` pages a fan's members. The store gateway implements both, the tenant proxy and responder carry them, and core exports `summarizeTimeline`, `summarizeFan`, `pageFan` and `childIdsOf`.
- **Dashboard server.** `GET runs/:id` summarizes fans wider than 50 by default (`?full=true` for everything), and `GET runs/:id/fans/:group` pages one fan's members.
- **Dashboard client.**
  - A summarized fan is one node in the timeline and the graph: `label ×size`, a progress bar per status, and the failures.
  - Expanding a fan loads its members page by page into a virtualized list, with a failed-only filter.
  - No child detail is fetched for a summarized fan, and other child fetches are capped at 50.
  - The header lists 12 child chips plus `+N more`.
  - Live events refetch at most every 1.5s, and the graph layout is memoized.
