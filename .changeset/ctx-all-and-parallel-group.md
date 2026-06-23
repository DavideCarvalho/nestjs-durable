---
"@dudousxd/nestjs-durable-core": minor
---

Add `ctx.all(workflow, inputs, { mode })` — run N child workflows in parallel and wait for all results (parity with the Python `durable-worker` `gather_children`). `mode: 'waitAll'` (default) aggregates child failures into a `GatherError`; `mode: 'failFast'` rejects on the first failed child. Results are returned in input order.

Also persist a `parallelGroup` tag on step checkpoints: a worker's `ctx.gather` / `ctx.all` tags every step/child in a parallel fan with the same group, and the engine now carries it from the `recordStep` / `startChild` command onto the checkpoint so the dashboard can render the fan as one group. Additive and optional — ordinary sequential steps are untagged and unaffected.
