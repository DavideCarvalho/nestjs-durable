---
'@dudousxd/nestjs-durable-core': patch
---

A run is no longer executed twice when a fast step result races the orphan sweep.

Three fixes to one race, seen as intermittently hung (or failed) durable chat turns in flip's e2e
suite, where an in-process worker answers a dispatched step in a couple of milliseconds:

- **A turn releases its lease only after its settled state is written.** `runExecutionTurn` returned
  `this.settleRun(...)` without awaiting it inside `try … finally { releaseRunLock }`, so the
  `finally` ran first: the run sat unlocked while its row still read `running`. Every settle in that
  block is now `return await`ed.
- **`recoverIncomplete` decides on the run it locked, not the one it listed.** It trusted the status
  from `listIncompleteRuns`, a snapshot taken before it reached the row. A run that had since
  suspended (and whose fast step result had already landed) read as "free lease, `running`, nothing
  in flight" — a crashed turn — so the sweep counted a recovery attempt, rewrote it to `pending` and
  re-enqueued it, starting a second execution beside the one the result had resumed (or resurrecting
  a finished run). It now re-reads the run under the lease and skips it unless it is still
  `running`/`cancelling`.
- **A replay re-reads a `pending` remote step before acting on it.** With `remoteRedispatchMs` set,
  a replay that found its step pending in its start-of-execution snapshot stamped the lease by
  writing `{ ...snapshot, wakeAt }` back — overwriting a result that had landed since with `pending`
  and parking the run on a lease an hour out. The step is now re-read from the store first; a result
  that has landed is replayed instead.
