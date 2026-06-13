# @dudousxd/nestjs-durable

## 0.2.1

### Patch Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

## 0.2.0

### Minor Changes

- Add a `worker` option to `DurableModule.forRoot/forRootAsync` (default `true`). Set `worker: false`
  for a **dashboard/dispatch-only** instance — typically an API pod — that mounts the control plane and
  keeps the engine available (dispatch, retry/cancel, reads) but does **not** play the worker role:
  it won't register `@DurableStep` handlers (no consuming the task queue), won't recover incomplete
  runs on boot, and won't poll due timers. Leave that to the worker instances. Lets you run the engine
  on `APP_TYPE=worker|all` and the dashboard everywhere without two instances competing to process work.
