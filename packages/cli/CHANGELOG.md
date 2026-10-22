# @dudousxd/nestjs-durable-cli

## 0.3.0

### Minor Changes

- [#406](https://github.com/DavideCarvalho/nestjs-durable/pull/406) [`4d9e840`](https://github.com/DavideCarvalho/nestjs-durable/commit/4d9e8406948130b55de0072e1276bbe06666ddd3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Replay fixtures for CI.

  - The testing kit adds `captureHistory(engineOrStore, runId)`, `serializeRunHistory(history)` and `parseRunHistory(json)`. Use them to capture a run with its checkpoints as a JSON fixture, commit it, and assert it with `assertReplayable(register, parseRunHistory(json))`.
  - `durable export <runId> [--out file]` writes the same fixture from your configured store.
  - Both writers stamp core's new `RUN_HISTORY_FIXTURE_VERSION` (re-exported by the testing kit), and `parseRunHistory` rejects a fixture stamped with any other version. A fixture without `version` is read as version 1.

- [#406](https://github.com/DavideCarvalho/nestjs-durable/pull/406) [`4d9e840`](https://github.com/DavideCarvalho/nestjs-durable/commit/4d9e8406948130b55de0072e1276bbe06666ddd3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stalled-run pager.

  - `engine.onStalled(listener)` reports stranded runs: a run untouched for `stalledAfterMs` (default 15 minutes) that is either suspended with no wake timer, or parked on an old pending remote step that nothing is leasing. `engine.sweepStalled()` does the sweep. It is throttled to one pass a minute, skipped while draining, a no-op without listeners, scoped to the engine's namespace, and it reports each stranded episode once per instance.
  - The NestJS timer poller calls `sweepStalled()` every tick on a driving operator. `DurableModule` gains the `stalledAfterMs` and `onStalled` options.
  - `engine.listStalledRuns(opts)` and the standalone `findStalledRuns(store, opts)` run the same query on demand.
  - CLI: `durable inspect --stale[=<duration>]` lists stranded runs (default threshold 15m), and `--namespace <ns>` narrows any listing.

## 0.2.0

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
