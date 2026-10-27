---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/durable-worker": patch
"@dudousxd/nestjs-durable-transport-bullmq": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
---

A wide step fan no longer spends most of its CPU remembering which results settled here, and the
adaptive step concurrency no longer collapses to one on fast steps.

- The engine's "settled here" maps were pruned by walking every entry once a map held 1,024, and in
  a fan every entry is younger than a lease, so each result walked them all: 12% of a 40k fan's CPU.
  Pruning now stops at the first entry still fresh, and a fan's steps are not recorded one by one
  (the fan's barrier covers them).
- The adaptive controller read latency jitter as queuing: its baseline is the fastest completion of
  the window, and for 1–5 ms steps p50 sits several times above it with nothing queued, so it
  shrank to one or two at a time. p50 may now reach twice the baseline plus 5 ms before it counts
  as queuing. Growth doubles the limit until the first back-off, then adds √limit a tick (it added
  one every 2 s); until that first back-off, growth is re-decided after each limit's worth of
  settled steps instead of waiting for the 2 s tick. Step durations are timed with
  `performance.now()` instead of whole milliseconds.
  The Python worker's controller makes the same decisions (durable-worker 0.26.2).
- The turn that joins a step fan no longer reads the fan's checkpoints twice: settled ones come from
  the turn's own snapshot, and only those it holds `pending` are read again.
- The MikroORM store reads and writes checkpoints through the query builder instead of managed
  entities (`listCheckpoints`, `getCheckpoints`, `saveCheckpoints`, `saveCheckpointsIfPending`):
  40k rows read in 0.14 s instead of 0.7 s, written in 1.5 s instead of 2.2 s.

A 40k-step fan on four local processes (MySQL, BullMQ): 42 s before, 16 s after; one process: 60 s
before, 28 s after.
