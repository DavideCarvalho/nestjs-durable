# @dudousxd/nestjs-durable-transport-db

## 0.2.2

### Patch Changes

- [#394](https://github.com/DavideCarvalho/nestjs-durable/pull/394) [`6625d13`](https://github.com/DavideCarvalho/nestjs-durable/commit/6625d13a8fa0bfabbe7573a4620f8e240350d966) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - DbTransport no longer runs a task twice when it outlives `leaseMs`, and a worker that lost its claim no longer deletes another instance's row.

  - Every claim the instance holds is renewed every `leaseMs / 3` (the running row and the rows waiting behind it), so only a crashed or event-loop-blocked worker loses its rows.
  - The task loop claims only as many rows as it has free slots. New `concurrency` option (default 1) sets how many tasks run at once.
  - Claims are stamped with a per-round token. A claim is re-checked before the handler runs, and the task row is deleted and its result written in one transaction, only while that token still holds the row. The engine deletes a result row only under its own claim token.
  - A result already waiting for the same `step_id` is replaced instead of kept, so a retry's result is never dropped.
  - New `onError` option. A throwing result handler is reported and its row re-delivered after the lease; the rest of the batch continues.
  - `instanceId` defaults to a random UUID (two instances booted in the same millisecond used to share one).
  - A failed `CREATE TABLE` (two instances racing it on a fresh database) is retried instead of breaking the transport until restart.
  - A non-finite numeric option (`NaN`, `Infinity`) falls back to its default instead of reaching the SQL as `LIMIT NaN`.

## 0.2.1

### Patch Changes

- [#333](https://github.com/DavideCarvalho/nestjs-durable/pull/333) [`6d3c877`](https://github.com/DavideCarvalho/nestjs-durable/commit/6d3c877ef7608ee7809b884c3e919716fc7b480f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The Drizzle store now runs on **PostgreSQL**, and accepts drizzle-orm 0.45.

  `@dudousxd/nestjs-durable-store-drizzle/pg` is a new entry point with a `DrizzlePgStateStore` that
  takes any drizzle Postgres db (node-postgres, postgres-js, PGlite, Neon, …). The package root is
  unchanged and stays the SQLite / libSQL store.

  - **Schema both ways.** The six `durable_*` tables ship as `pgTable`s (`durableWorkflowRuns`, …,
    bundled as `durablePgSchema`) to re-export into your drizzle-kit schema, and as idempotent DDL
    (`DURABLE_PG_DDL`, `ensureDrizzlePgDurableSchema(db)`) that `ensureSchema()` runs on boot under an
    advisory lock when `autoSchema` is on. The two are identical — `drizzle-kit push` against an
    auto-schema database reports no changes — and a real-Postgres spec pins them together.
  - **Postgres-native.** `jsonb` payloads, `timestamptz` timers, canonical column names. Leases are a
    single conditional `UPDATE … RETURNING`; `takeSignalWaiter` is one `DELETE … RETURNING`;
    `takeBufferedSignal` claims with `FOR UPDATE SKIP LOCKED`. Tag filters are jsonb containment
    (`@>`) over a GIN index, so singleton gates stay index probes.
  - **Retention and tenant scoping.** Implements `pruneTerminalRuns` (batches selected with
    `SKIP LOCKED`, terminal statuses only), so the module's `retention` option works, and `withScope`,
    so `scopeReads` confines reads to a namespace.
  - **Broker-less remote steps.** `drizzlePgExecutor(db)` plugs the drizzle db into `DbTransport`.
    `transport-db` now marks its `typeorm` peer optional, since it only ever needed the executor.

  Passes the shared StateStore contract on node-postgres and postgres-js against real Postgres.

  The drizzle-orm peer range now includes `^0.45.0`; the SQLite store is tested on 0.45.3.

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

## 0.1.1

### Patch Changes

- Carry `startedAt` through the SQL transport so queue-wait works over it too: the results table gains
  a nullable `started_at` column, written from the worker's pickup time and surfaced on the polled
  `StepResult`. Brings the DB transport in line with BullMQ/SQS (which already forwarded it) and with
  the Python `db_runner`. The column is added to the auto-created schema; an existing
  `*_transport_results` table from a prior release should be dropped (it's transient) so it picks up
  the new column.
