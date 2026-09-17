---
'@dudousxd/nestjs-durable-core': patch
---

Throttle the two durable deadline renewals a heartbeat performs, so a hot beat loop is not an
`UPDATE` storm.

A worker beats while it holds a long step (or replays a long workflow turn) — every couple of
seconds, and a `gather_calls` fan-out multiplies that by its in-flight steps. Two engine-side rearms
paid for every one of those beats:

- `rearmStepLease` (the step-scoped beat, new in 0.71) did a `getCheckpoint` + a `saveCheckpoint`,
  plus a `getRun` + `updateRun` whenever the run happened to be parked exactly on that step's lease.
  Its `cp.wakeAt >= renewed` guard could only ever short-circuit a second beat inside the same clock
  tick, because `renewed` advances with the clock.
- `rearmDecisionDeadline` (the run-scoped beat for a turn suspended on `remoteAdvanceSilenceMs`) did
  a `getRun` + `updateRun`, with no guard at all.

Both are now throttled **by the window itself** rather than by a fixed interval: a renewal buys at
most one window, so it is only worth a write once the window is HALF spent. A beat that finds more
than half the window still on the clock writes nothing and records the half-spent mark, so later
beats skip even the read until then; a beat at or past the mark renews, leaving a full half-window of
headroom — the deadline can never lapse under a worker whose beats are anywhere near their normal
cadence.

That bounds the cost at one read + one write per half window per in-flight step (and per suspended
turn), independent of beat frequency: with a 30-minute `remoteRedispatchMs`, two writes an hour
instead of ~1800. Measured in the new tests, 120 beats across a full window now cost 2 writes and 3
reads, down from 120 of each.

The in-memory mark is a pure optimisation — cold on a fresh instance, or on the one that did not
dispatch the step — and the durable half-spent check re-derives the same answer from the checkpoint
(or the run), so nothing depends on it surviving; it is cleared wholesale past 1024 entries.

Both rearms are also fully best-effort now: every store call they make — the reads AND the writes —
is swallowed. They run inside the transport's beat handler, which delivers beats serially and does not
catch, so a throwing store call would take the beat loop down with it (on `bullmq`, where the
subscriber does `void handler(...)`, as an unhandled rejection that can kill the process). Nothing is
silently left stale: the half-spent mark is only advanced once the renewal write commits, so the very
next beat retries, and a skipped beat is harmless by the same headroom argument that justifies the
throttle.
