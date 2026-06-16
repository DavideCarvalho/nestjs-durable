# @dudousxd/nestjs-durable-telescope

## 0.3.0

### Minor Changes

- 613f356: Workflows dashboard "Recent failed runs" table is now time-bounded and shows when each failure happened. The `durable.recentFailures` provider only returns failures updated within a window (default 24h; `durableTelescopeExtension({ recentFailuresWindowMs })` to tune, `0` for all) and includes a compact `updatedAt` stamp per row — so a healthy system shows an empty table instead of surfacing days-old failures as if they were a live incident.

## 0.2.0

### Minor Changes

- 76e9977: Add `durableTelescopeExtension()` — a first-class Telescope extension that adds a native "Workflows" health dashboard. Register it via `TelescopeModule.forRoot({ extensions: [durableTelescopeExtension({ runHref })] })`. It bundles the existing `DurableTelescopeWatcher` plus a `durable.workflows` dashboard (success rate, failed-in-window, current-state gauges for dead/suspended/running/pending, top failing workflows, and a recent-failures table that deep-links each run out to the durable dashboard via `runHref`). Rollups come from the `durable` entries Telescope already captures; current-state gauges read the durable store live via `listRuns`. Requires a `@dudousxd/nestjs-telescope` version that supports the `extensions` option. The standalone `DurableTelescopeWatcher` export is unchanged.
