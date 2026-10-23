# @dudousxd/nestjs-durable-transport-db

## 0.3.0

### Minor Changes

- [#392](https://github.com/DavideCarvalho/nestjs-durable/pull/392) [`274c0f3`](https://github.com/DavideCarvalho/nestjs-durable/commit/274c0f33ca49f5dd1c2c02b08f164b61b54d7a3f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Wide `ctx.all` fans survive crashes and scale-downs, and their children run across every instance of the deployment instead of on the one running the parent.

  - **Runs spread over the deployment.** A new optional transport capability, `Transport.dispatchRuns(runs, { namespace })` and `Transport.onDispatchedRun(handler, { concurrency, namespace })`, is a run queue every driving instance consumes. Once an engine consumes it (`engine.consumeRuns()`, which the Nest module calls on every driving operator, never on `drive: false` or a thin worker), every run it starts or re-drives goes there instead of executing on the instance that triggered it: `start`, `ctx.child` and a `ctx.all` fan's children (in bulk writes of up to 500), event and schedule triggers, `signalWithStart` and entity runners, continue-as-new, `requeue`/`retryWithInput`, `recoverIncomplete`, a freed singleton slot's next run, and the pending runs and due timers the poll finds. Each instance takes at most 256 at once; a queued run is not also announced over the control plane. A run whose queueing fails stays `pending` and the next poll queues it again, or runs it itself while the broker is down. At shutdown an instance stops taking runs and waits for the ones it holds within `shutdownTimeoutMs`. Wakes of a run (step results, signals, a child reaching its parent) still resume it where they land. BullMQ (`<prefix>-runs`, job id = run id, `addBulk`, priority), SQS (`<prefix>-runs`, `SendMessageBatch`, FIFO-aware, new `runsQueueUrl` option) and the SQL transport (`<prefix>_transport_runs`, `SKIP LOCKED`) implement it; the event-emitter transport stays in-process. Workflow code and configuration are unchanged. `runRunDispatchContract` in the testing package is the shared contract for a transport's run queue, and `InMemoryRunQueue` in core is its reference implementation.
  - **The SQL transport tolerates two instances creating its tables at once**, which Postgres reported as a unique violation that also stuck: the failed schema promise was cached for the life of the transport.

  - **A child completion that never reached its parent is delivered by the parent.** A child persists `completed`/`failed` and then notifies its parent. A crash, scale-down or store error between the two left the parent's `running` placeholder and `child:<id>` waiter behind, and the parent's reconcile wake replayed straight back to the same wait, forever. Each turn of a run now reads the children it waits on (one batched read per 500, from its `running` placeholders, or from its `child:` waiters for a remote workflow) and settles the finished ones exactly as the notification would have. The notification itself retries a store error a few times, and a graceful shutdown waits for notifications in flight.
  - **A step result whose resume was lost still resumes the run.** A redelivered result whose step had already settled was dropped, so a transport retry of a result whose resume failed, or whose instance went down after the write, left the run `suspended` on a finished step. It now resumes a `suspended` run (subject to a step fan's barrier). A resume that found the run leased by another instance looks again once that lease is free, so a holder that went down mid-turn costs one lease period. With `remoteRedispatchMs` set, a run waiting on a dispatched step parks no later than `reconcileMs` instead of on the redispatch deadline (an hour, say).
  - **One instance never runs two turns of the same run side by side.** `execute` admits an instance into a lease it already holds, so wakes landing together each ran a whole turn: the last few hundred children of a fan settling at once replayed the parent hundreds of times concurrently, each with every checkpoint loaded. Wakes that arrive while a turn executes now share one more turn after it. A 5,000-child fan on a pooled store: 509 parent turns and a 1.86 GB heap peak before, 2 turns and 22 MB after.
  - **One in-process budget of 256 per instance** covers the runs it takes off the run queue, a fan's child starts and, on a transport without a run queue, the runs it starts and those announced to it as enqueued (`engine.runEnqueued`, which the Nest timer poller now uses and which skips a run already taken). The bound is internal; there is no option to set.
  - **A cancelled child tells its parent**, like a failed or dead one: `ctx.all` / `ctx.child` fail on it, `ctx.allSettled` reports a rejected entry coded `cancelled`, and a parent's turn reconciles cancelled and dead children it never heard from. A child cancelled because its parent was does not write to the cancelled parent. A `failFast` fan keeps reporting the failure that failed it when the siblings it cancelled report back.
  - **A late child notification leaves no stray buffered completion** once the parent already settled that child on its own.
  - **Reconciling a fan on a store without `getRuns`** settles every child it could read; a child whose `getRun` failed is left to the next turn instead of deferring its whole batch of 50.
  - **Wakes go through the run queue too**: a signal, a child's completion reaching its parent, a due timer (claimed for one lease period while its wake waits), a freed singleton or queue slot, a lease that came free. `RunDispatch` carries `reason: 'start' | 'wake'` and a start's `key` (its `pending` state). Step results and decisions still resume their run where they land. **Behavior change:** while the engine consumes a run queue, `engine.signal` (and `signalWithStart`, entity operations) resolves once the wake is queued, with the run's status at that moment; use `waitForRun` for the outcome. A wake the transport refuses resumes the run locally.
  - **No dispatch is lost to deduplication**: BullMQ gives a start the job id `start-<runId>-<key>` (the scheme adonis-agora-durable uses) and a wake none, so a run that went `pending` again, or a wake, landing while its previous job is being handled is a new job. The SQL transport's upsert releases a held claim (and keeps a wake a wake); SQS delivers at least once. The shared contract checks all three.
  - **`StateStore.getRuns(runIds)`** (optional): the existing runs among the ids, in one `IN (...)` read. Every bundled store implements it, `CodecStateStore` forwards it, and the shared store contract covers it. A replaying fan uses it instead of one `getRun` per child; without it the engine falls back to `getRun`, 50 at a time.

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
