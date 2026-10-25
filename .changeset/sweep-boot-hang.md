---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-testing": patch
---

A worker boots while its first timer poll is still running, and the buffered-signal sweep costs a few queries per page instead of one per row.

- **Boot no longer waits for the first poll.** `TimerPoller.onApplicationBootstrap` (and `RetentionPoller`'s) started the first poll and awaited it. Nest runs every `onApplicationBootstrap` before the HTTP server listens, so a first poll held up by a backlog kept the pod from passing its readiness probe and the rollout failed. The first poll is now started in the background. Shutdown still waits for the poll in flight, bounded by `shutdownTimeoutMs`.
- **`engine.sweepBufferedSignals()` decides a page set-based.** For each buffered `child:` row it used to read the parent's checkpoints with a `LIKE` on the checkpoint name, and nothing indexes `(run_id, name)`. On a 40,000-child parent that meant one scan of 40,000 rows per buffered row. Now it reads every parent's run row in one batch: a gone or finished parent condemns its rows with no checkpoint read at all. For each parent that is still open, it reads the checkpoints the child ids point to by `(run_id, seq)` on the primary key, one call per parent per page. A `ctx.all` child `<p>.all.<first>.<i>` settles at seq `first + i`, and its fan's fold is at `first` (for a fan in waves, at `first + k * W`, where `W` is the length of wave 0's fold). A read by name is left only for ids that name no seq (an onError handler, a `ctx.startChild` child whose signal is not at its spawn seq, a fan in waves whose wave 0 did not fold).
- **The sweep has a time budget.** One call stops starting pages or parent reads after 250 ms of wall-clock time and resumes from there on the next tick. It still never runs concurrently with itself.
- **The child-completion check on the write path reads by key.** `childCompletionNeedsBuffer` runs on every completion of a wide fan that finds no waiter. It now does `getRun` plus one `getCheckpoints` for the child's seq and the fold's, instead of a `LIKE` over the parent's checkpoints.
- The shared store contract checks that one sweep of 500 buffered rows of a 4,000-checkpoint parent sends at most 10 statements. It sends 6 on SQLite, Postgres and MySQL; it was 504 before.
- An opt-in MySQL harness (`packages/store-mikro-orm/src/buffered-sweep.harness.db.spec.ts`, `DURABLE_HARNESS=1 pnpm test:db …`) reproduces the shape that broke a rollout: a 40k-child parent, 20k of its children's completions buffered, 42k buffered rows, ~380k checkpoints and ~167k runs. It measures one sweep tick and the write-path check.
