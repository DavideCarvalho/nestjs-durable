---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-dashboard": minor
---

Dashboard polish: fix-and-replay, run tree, more metrics.

- **Fix-and-replay**: `engine.retryWithInput(runId, input)` re-runs a dead/failed run with a corrected input as a fresh linked run (the original stays inspectable). The dashboard run detail gets a **"Fix & replay"** button (edit the input JSON, re-run) for dead/failed runs.
- **Run tree**: the run detail now lists the run's **children** (`ctx.child` / `ctx.startChild`), clickable to navigate the parent→children tree.
- **Metrics**: `/metrics` adds a `durable_running_runs` gauge (alongside the `durable_pending_runs` backlog + `durable_dead_runs` DLQ-size gauges).
