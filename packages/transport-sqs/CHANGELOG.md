# @dudousxd/nestjs-durable-transport-sqs

## 0.3.1

### Patch Changes

- [#423](https://github.com/DavideCarvalho/nestjs-durable/pull/423) [`6b24c80`](https://github.com/DavideCarvalho/nestjs-durable/commit/6b24c80e8e9a01f187a86ed5214870690a1b389b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A wide step fan's results are applied at the rate its steps finish, instead of piling up on the results queue while the workers sit idle.

  - **The results consumers take many results at once.** The engine settles one run's waiting results together (one `saveCheckpointsIfPending` per batch of up to 256), but a batch can only hold the results the transport has handed over. BullMQ handed over `resultConcurrency` results per instance (default 1), and the SQS and SQL transports one at a time, so a 40,000-step fan was settled a handful of results per write, each write followed by a barrier `COUNT` over the whole fan. The BullMQ results consumer now works on up to 512 results at once per instance; the SQS transport runs eight receive loops that each hand over every message of a receive at once; the SQL transport claims rounds of up to 256 result rows, hands them over at once, deletes the settled ones in one statement, and claims the next round while one runs (up to 512 in flight). A result is still acknowledged only after its write committed.
  - **A step fan's barrier is read once a backlog drains, not once per batch.** A batch with another of the fan's results already queued behind it on the same instance leaves the barrier to that result, which reads it once its own batch is written (as a settle, or as a redelivery of a settled step). Under a backlog the fan's barrier is read about once per instance instead of once per batch, and the parent still wakes once per settled wave.
  - **A batch reads its checkpoints with one query.** The new optional `StateStore.getCheckpoints(runId, seqs)` reads one run's checkpoints at many seqs at once; the engine reads a batch's checkpoints through it instead of one `getCheckpoint` per result, which on a connection pool of 10 queued each read behind the batch's others. Every bundled store implements it (MikroORM, TypeORM, Prisma, Drizzle on SQLite and Postgres, and the in-memory and codec stores); a store without it keeps one read per result. The shared store contract checks it.
  - **The MikroORM store writes a batch in a few statements.** `saveCheckpointsIfPending` locks the batch's still-`pending` rows with one `SELECT … FOR UPDATE`, decides each entry against them in order, and writes the winners with one upsert per 500 rows, instead of one conditional `UPDATE` per entry inside the transaction.
  - **The TypeORM, Prisma and Drizzle (SQLite) stores write a batch in a few statements too.** TypeORM locks the still-`pending` rows with one `SELECT … FOR UPDATE` and writes the winners with one upsert per 500 rows. Prisma, which has no multi-row conditional update, reads them, deletes the still-`pending` ones and re-creates them with `createMany`; a row settled by someone else in between rolls the batch back and the engine settles it row by row. Drizzle on SQLite reads them and upserts the winners in its one writing transaction. Prisma's `registerChildWaits` replaces a child fan's waiters and placeholders the same way, instead of one upsert per row, which on MySQL ran a 500-child fan past Prisma's 5 s transaction timeout. The store contract checks it, with a statement counter, on SQLite and on real Postgres and MySQL.
  - **The dispatching turn sends a fan in bulk.** New optional `StateStore.saveCheckpoints(checkpoints)` writes a fan's new `pending` checkpoints in one call (a few statements, one transaction) instead of one `saveCheckpoint` per step: every bundled store implements it and the store contract checks it. New optional `Transport.dispatchMany(tasks)` sends the fan's tasks in a few broker calls: BullMQ `addBulk` (500 jobs a call, four in flight), SQS `SendMessageBatch` (ten a call, ten in flight), the SQL transport one multi-row insert per 200 tasks. A transport without it, or a batch it refuses, gets one `dispatch` per task. In the MySQL harness below, the dispatching turn of a 20,000-step fan takes about 4 s instead of about 45 s, and a 40,000-step fan about 7 s.
  - **Two instances that see a fan's barrier open at once run one parent turn, not two.** The one that could not take the run's lease keeps its wake tagged with the fan; the turn holding the lease drops a kept wake for a fan it read settled at least that far, instead of running the parent again. A turn that runs while a fan is out no longer re-reads each pending step of it either: such a turn costs a fixed number of store calls.
  - **A wake kept for a turn survives the instance that looks at it going down.** A wake that finds the run leased by a turn on another instance is kept as a buffered event, and it is now deleted only once a turn that started after it has settled, instead of being taken by the instance that looks at it. The instance that decides to run the turn for it first brings the run's timer forward to when its own hold on the run would lapse, and the instance that kept the wake does the same for the holder's lease. A turn that suspends while a wake it did not see is kept also keeps the run due by its lease's end, since its suspension overwrites the timer the keeping instance set. So if either goes down before the turn runs, any instance's timer poll resumes the run then, instead of its reconcile wake (5 minutes by default). Wakes kept as buffered signals by an older engine are still taken.
  - `resultConcurrency` on `BullMQTransport` now only raises the limit above 512; there is no need to set it for wide fans.
  - The new shared contract `runStepFanResultsContract` checks, for a transport, that a `ctx.all` / `ctx.allSettled` step fan (with and without `concurrency`) whose results back up on the broker is settled over two instances in batches, every step once, with O(1) parent turns per wave. It also checks that a transport with `dispatchMany` sends the fan's steps through it. It runs against BullMQ (Redis), the SQL transport (Postgres and MySQL), SQS (ElasticMQ) and the in-memory transport.
  - An opt-in throughput harness (`packages/store-mikro-orm/src/fan-throughput.harness.db.spec.ts`, `DURABLE_HARNESS=1 pnpm test:db …`) runs a wide fan on MikroORM over MySQL and BullMQ over Redis across several instances and prints where the time went.

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

## 0.2.1

### Patch Changes

- [#394](https://github.com/DavideCarvalho/nestjs-durable/pull/394) [`f67bea3`](https://github.com/DavideCarvalho/nestjs-durable/commit/f67bea3452672027aa5daed1a6797d548da440ee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - SqsTransport's poll loops no longer stop consuming on the first failure, and a received batch no longer runs twice.

  - A result handler that throws, a result `SendMessage` that fails, a message body that isn't JSON or a failing queue-URL resolution is reported through the new `onError` option (default `console.error`) and the loop moves on. The message is not deleted: SQS redelivers it after its visibility timeout, and a redrive policy moves one that keeps failing to a DLQ. These used to reject the loop's promise (an unhandled rejection) and leave the instance consuming nothing.
  - Every message of a received batch is kept invisible (`ChangeMessageVisibility` every third of the timeout) while it waits or runs. The messages behind a slow one used to reappear and run on another worker.
  - A `taskQueueUrl` resolver is now called once per group and cached, as documented.
  - The backoff after a failing receive no longer leaves an `abort` listener behind on every call.

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
