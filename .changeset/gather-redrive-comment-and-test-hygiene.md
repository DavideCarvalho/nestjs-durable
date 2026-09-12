---
'@dudousxd/nestjs-durable-core': patch
---

Tidy the gather re-drive landed in 0.70.2 — no behaviour change.

The stale-history rationale had been written out twice in full: seven lines inline in
`applyDecision` and again in `redriveIfTurnSawStaleHistory`'s JSDoc. Two copies of one
explanation drift apart, so the inline one is now a pointer to the method that owns it.

The regression spec's store subclass recorded every suspend and never asserted on it. The
count is now load-bearing: the spec asserts the run suspended AFTER the stale decision was
served, which pins down that the engine recovers *out of* the parked state. Without that,
the spec would also pass if the engine simply never applied the stale decision — a
different behaviour that happens to reach the same terminal status.
