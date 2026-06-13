# @dudousxd/nestjs-durable-dashboard

## 0.2.1

### Patch Changes

- Record a step's **input** on its checkpoint, alongside the output. A remote step's `ctx.call` args
  are now persisted and surfaced in the dashboard step panel ("Input" + "Output" shown separately,
  instead of only the output) — so you can see what a step was called with, not just what it returned.
  Stored as a nullable column across all four store adapters; the in-memory store carries it for free.

## 0.2.0

### Minor Changes

- Make the dashboard mount path configurable via `DurableDashboardModule.forRoot({ basePath })`.
  Previously the control plane was hardcoded to `/durable`; now you can mount it anywhere — e.g.
  `forRoot({ basePath: '/api/durable' })` to bring it under your app's `/api` prefix so its auth/proxy
  rules cover the dashboard API too. The SPA's asset URLs and API base are derived from `basePath` at
  serve time, so the bundle works at any mount point.

  **Breaking:** import via `DurableDashboardModule.forRoot()` instead of the bare `DurableDashboardModule`
  (`forRoot()` with no args keeps the previous `/durable` default). Requires `@nestjs/core` as a peer
  (for `RouterModule`) — already present in every NestJS app.

## 0.1.1

### Patch Changes

- Add native step timing/status: checkpoints now record `enqueuedAt` (dispatch) →
  `startedAt` (worker pickup) → `finishedAt` (done), so you can see how long a step
  waited in the queue before a worker began processing it (queue-wait =
  `startedAt − enqueuedAt`). The worker's start time flows back through the single
  `runStepHandler` choke point, so every transport reports it for free. A new
  `step.started` event announces a remote step as in-flight, and `step.completed` /
  `step.failed` events carry `queueMs`. The dashboard step panel surfaces the queue
  time alongside the processing duration. Stored as a nullable column with a
  back-compat fallback to `startedAt` for rows written before this release.
