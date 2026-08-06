---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-testing': minor
---

Start a specific workflow version, and take a timed-out run's children with it

`engine.start` could only ever run whatever version was newest — a version was honoured on `resume`
but nowhere at start — so a caller that recorded the exact `name@version` it meant to run could not
actually run it. `StartOptions.version` (and `ChildCallOptions.version`, for `ctx.child` /
`ctx.startChild`) now targets an exact registered version. Omit it and nothing changes: `latest` is
still the default. A version that is not registered throws before a run row exists rather than
falling back to the newest — silent fallback is the failure this exists to prevent. It resolves
against real registrations only (`register` / `registerRemote` / `remote`); the two synthesized paths
that exist because nothing is registered — a child inheriting its remote ancestor's routing, and
convention routing to a live worker group — refuse a pin instead of inventing a version nothing has
verified.

`sweepTimeouts` marked a timed-out run `cancelled` directly, bypassing `cancel`, and so never
cascaded: a child outlived the parent that spawned it with nothing pointing at it, invisible until
somebody read the runs table by hand. It now runs the same recursive child cascade `cancel` does, so
the whole subtree goes — children of children included — while keeping the direct terminal write that
gives the parent its `execution_timeout` error code and keeps the per-tick scan cheap. Idempotent
under concurrent sweeps, never clobbers a child that already finished, and terminates on a cyclic
parent-child graph.
