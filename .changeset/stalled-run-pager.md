---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-cli": minor
---

Stalled-run pager.

- `engine.onStalled(listener)` reports stranded runs: a run untouched for `stalledAfterMs` (default 15 minutes) that is either suspended with no wake timer, or parked on an old pending remote step that nothing is leasing. `engine.sweepStalled()` does the sweep. It is throttled to one pass a minute, skipped while draining, a no-op without listeners, scoped to the engine's namespace, and it reports each stranded episode once per instance.
- The NestJS timer poller calls `sweepStalled()` every tick on a driving operator. `DurableModule` gains the `stalledAfterMs` and `onStalled` options.
- `engine.listStalledRuns(opts)` and the standalone `findStalledRuns(store, opts)` run the same query on demand.
- CLI: `durable inspect --stale[=<duration>]` lists stranded runs (default threshold 15m), and `--namespace <ns>` narrows any listing.
