# @dudousxd/nestjs-durable-otel

## 0.4.1

### Patch Changes

- [#430](https://github.com/DavideCarvalho/nestjs-durable/pull/430) [`cccf750`](https://github.com/DavideCarvalho/nestjs-durable/commit/cccf7505aa92b7bd2519aef844c56c231921cc60) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Lifecycle events are recorded once across a deployment, by the instance that produced them. With a
  control plane every instance hears every event (that is what lets the dashboard live-tail a run from
  any pod), and the Telescope watcher, the core metrics, the OpenTelemetry spans and metrics and the
  diagnostics bridge each recorded every event they heard: once per pod. In a 12-pod deployment one
  40,000-step fan wrote 612,000 Telescope entries instead of about 80,000, and that write load saturated
  the database the run itself was using. The core now marks an event re-delivered from another instance
  (`isRemoteEvent(event)`), and those surfaces skip it. They read the mark by symbol, so an older core
  keeps working as before.

## 0.4.0

### Minor Changes

- [#383](https://github.com/DavideCarvalho/nestjs-durable/pull/383) [`cf54b7a`](https://github.com/DavideCarvalho/nestjs-durable/commit/cf54b7ad7a8eafc33020117ceb2b1ec7e1b37333) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - onError polish:
  - Metrics count `run.routed` / `run.unrouted` (`runs.routed`, `runs.unrouted`, `routedByCode`, Prometheus `durable_runs_routed_total{code}`); the OTel bridge adds `durable.run.routed` / `durable.run.unrouted` span events; Telescope tags them `routed` / `unrouted` and `onError:<code>`, with the `reason`.
  - The console shows a failure's `code` and `details` on the failed step and run.
  - The boot warning for an unserved onError route rechecks after 30s, so handlers whose workers start later are not reported.
  - A retry drops the run's `onError:<code>` tag along with the retired handoff.
  - `listCheckpointsByNamePrefix` and `listSignalWaiters` match a prefix literally on every SQL store: `_` / `%` were read as `LIKE` wildcards (and Prisma's `startsWith` on SQLite). New conformance case.
  - Python: `ctx.gather_calls_settled`.

## 0.3.0

### Minor Changes

- 687face: Ecosystem improvements across the durable runtime, stores, transports, and tooling.

  ### Scheduling

  - **Schedule jitter + backfill.** Cron/interval schedules can now spread fire
    times with configurable jitter to avoid thundering-herd dispatch, and missed
    occurrences (e.g. while a worker was down) can be backfilled deterministically.

  ### Cancellation

  - **Cancel-by-event.** New `cancelWhere(filter)` cancels all matching runs by a
    declarative filter, complementing single-run cancellation.

  ### Search attributes

  - **Indexed search-attribute side-table pushdown.** Equality and range queries
    over search attributes are pushed down into an indexed side-table across every
    store — TypeORM, MikroORM, Prisma, Drizzle, and the in-memory store — instead
    of scanning and filtering in application code. The side-table is re-indexed on
    update so stale attribute values stop matching.

  ### Singleton admission

  - **Backpressure + notify-on-release + `maxQueueDepth`.** Singleton admission now
    applies backpressure with a configurable `maxQueueDepth`, and waiters are
    notified on release rather than polling.

  ### Queue

  - **Priority + per-key fairness.** The work queue supports per-message priority
    together with per-key fairness so that one busy key cannot starve others.

  ### Context propagation

  - **Opaque context carrier.** Context is now propagated through an opaque carrier,
    decoupling callers from the underlying transport/trace representation.

  ### Packaging

  - **Dual ESM/CJS publish.** Packages now ship both ESM and CJS builds. Decorator
    packages are built via SWC with `legacyDecorator` + `decoratorMetadata` to
    preserve emitted metadata; `testing`, `cli`, and `eslint-plugin` remain
    CJS/ESM as appropriate by design.

  ### Testing

  - **Testcontainers-backed integration specs.** BullMQ, SQS, DB, and Prisma now
    have testcontainers-backed integration specs that run under `test:db`, plus a
    fix to the BullMQ dispatch test shape.

## 0.2.0

### Minor Changes

- 6b36ffa: feat: propagate W3C traceparent to workers (distributed tracing)

  The engine now stamps a `traceparent` on every dispatched `RemoteTask` from an optional
  `traceparent` provider, so a worker (including the Python SDK) can continue the distributed trace
  instead of starting a detached one. Core stays OTel-free: the otel package exports `otelTraceparent()`
  (reads the active span via the registered W3C propagator) to wire in —
  `new WorkflowEngine({ traceparent: () => otelTraceparent() })` — and the NestJS module exposes a
  `traceparent` option. The wire field already existed; this populates it.

## 0.1.1

### Patch Changes

- Durability hardening (audit follow-up):
  - **Non-determinism detection**: on resume, a step whose name no longer matches the checkpoint recorded at that logical position throws `NonDeterminismError` instead of silently replaying the wrong checkpoint into the wrong step (the classic way a changed-under-flight workflow corrupts a run).
  - **Deterministic sources**: `ctx.now()`, `ctx.random()`, `ctx.uuid()` — checkpointed once and replayed verbatim, so workflows stop being corrupted by raw `Date.now()`/`Math.random()`/`randomUUID()`.
  - **Retry backoff**: `StepOptions` `backoff: 'fixed' | 'exp'` + `backoffMs`/`backoffMaxMs`/`jitter` is now actually applied between local-step retries (it was declared but ignored).
  - **Cancellation safety**: a cancelled/completed run is no longer re-executed by a late worker result or a duplicate `resume()`.
  - **testing**: `assertReplayable(register, history)` replays a recorded run's history against the current workflow code and throws on divergence — a CI guard that catches non-determinism before deploy.
  - **otel**: failed steps now emit a span (with error status), not just completed ones.
