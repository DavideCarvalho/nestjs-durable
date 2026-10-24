# @dudousxd/nestjs-durable-transport-bullmq

## 0.23.2

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

## 0.23.1

### Patch Changes

- [#422](https://github.com/DavideCarvalho/nestjs-durable/pull/422) [`58fc295`](https://github.com/DavideCarvalho/nestjs-durable/commit/58fc2958e45794a8c5a7b193888cdb7d77b85370) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - MySQL timestamps keep their milliseconds. The MikroORM and TypeORM stores created every timestamp column as a bare `datetime`, which holds whole seconds and rounds the milliseconds away: lease expiry, `wakeAt` and buffered-event order moved by up to half a second, so a timer could fire early and an engine could reclaim a lease it took just after booting as if a previous process held it. Columns are now `datetime(6)` (Postgres `timestamptz` was already microsecond, and is unchanged).

  An existing MySQL deployment is upgraded by the boot-time schema heal. MySQL runs that type change as a table copy that blocks writes, so on an existing table with more than `blockingAlterRowLimit` rows (default 100000; `schemaBlockingAlterRowLimit` on the store) the statement is logged for you to run out of band instead of run at boot, and the warning repeats each boot until the column matches.

  The BullMQ transport now rewrites every routing token's descriptor copy when a later `handle()` adds a step. A reader keeps whichever copy its SCAN meets first, so a stale copy left the new step's heartbeat undeclared, and the workflow directory listed that step's queue as a callable workflow until the next heartbeat interval.

  The StateStore contract fails instead of passing silently when its backend is unavailable and `DURABLE_TEST_REQUIRE_BACKENDS` is set.

  The run-dispatch contract's "leaves a run whose queueing failed pending" case waits for both re-queued runs to complete, since a consumer may take them in either order. Its "splits a fan's children across the instances" case holds each child until both instances have started one, so the split no longer depends on which in-process consumer the scheduler favours.

  The MikroORM store changes all of a table's timestamp columns in one `ALTER` (its schema diff emits one per column, and MySQL copies the table for each), and both stores log a deferred change as one copy-pasteable statement per table, one per line.

## 0.23.0

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

## 0.22.4

### Patch Changes

- [#404](https://github.com/DavideCarvalho/nestjs-durable/pull/404) [`b687ab6`](https://github.com/DavideCarvalho/nestjs-durable/commit/b687ab6e6f432cde1c16bb1cebad24fd3cae5044) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Correctness fixes ported from the AdonisJS sibling's audit.

  - `ctx.callEntity` and `ctx.signalEntity` are exactly once across replay. A replay of a `callEntity` still waiting for its reply used to send the operation again (two replays applied it three times), and a turn that died after a `signalEntity` dispatch applied it twice. The operation is now stored durably in the entity's buffer, tagged with the caller's `<runId>:<seq>`, before the caller checkpoints, and the entity's run is created with it. `callEntity` records a pending intent first and marks it as sent with a conditional write that never overwrites a reply that already landed. The entity skips a copy re-sent with the same id. The wake-up is a no-op message, so ops stay in arrival order, and a lost wake-up is recovered by the `reconcileMs` sweep.
  - `ctx.webhook().wait()` consumes a callback that arrived before the wait. `engine.signal` buffered it, but the wait never read the buffer, so the run waited forever. The wait now checks the buffer, registers, then checks again, like `ctx.waitForSignal`.
  - The dashboard's `POST webhooks/:token` buffers an early callback when the token's run exists and isn't terminal, and answers with the run's status. It answers `404` for a non-webhook token, an unknown or terminal run, or a wait that already resolved, and buffers nothing for those. Before, every unmatched POST left a buffered row behind and still answered `404`. A duplicate that races a callback resolving the same wait takes its buffered row back and answers `404`.
  - A child moved to `dead` by recovery (`maxRecoveryAttempts`) now notifies its parent right away as a failed child (`ctx.child` throws, `ctx.all`/`allSettled` record it). Before, the parent waited for its reconcile wake.
  - An empty-string namespace is the `default` pool. An engine configured with `namespace: ''` stamps and polls `'default'`, a run started with `{ namespace: '' }` is stamped `'default'`, and a run stamped `''` is no longer refused by a `'default'` engine's resume and decision guards. An unset namespace is still the operator. Every store writes `''` as `'default'`. The Drizzle stores (SQLite and Postgres) also read legacy `''` rows back as `'default'` and match them with every `'default'` filter. On the MikroORM, Prisma and TypeORM stores, rewrite legacy rows once with `UPDATE durable_workflow_runs SET namespace = 'default' WHERE namespace = ''`. Such rows exist only if an engine ran with `namespace: ''` before this release.
  - bullmq: a negative, NaN, infinite or above-2^31-1 `pingIntervalMs` falls back to the default instead of PINGing about every millisecond. A rejecting heartbeat handler is logged instead of becoming an unhandled rejection. When one `onDecision` handler fails, every handler runs to completion and each failure is reported before the decision is redelivered; before, the redelivery ran the others again while they were still running.
  - event-emitter transport: a rejection while processing a task goes to `onError` instead of becoming an unhandled rejection.

## 0.22.3

### Patch Changes

- [#394](https://github.com/DavideCarvalho/nestjs-durable/pull/394) [`e078eff`](https://github.com/DavideCarvalho/nestjs-durable/commit/e078effbee012b444558f5425db8d122c4c61c15) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - BullMQ consumer fixes, and a way to keep CLI/REPL processes from consuming.

  - `onDecision` delivers every decision to every handler registered on the transport. It used to keep only the first, so a second engine sharing the transport never received decisions.
  - `onResult` delivers every result to every handler, over one results worker. A second call used to start another results worker that replaced the first, and `close()` never closed the first one, so it kept consuming after shutdown. Two engines sharing a transport don't settle a result twice: the engine claims the step's pending checkpoint.
  - A `redis://` / `rediss://` connection string works. BullMQ copied a bare string onto its defaults character by character and connected to `127.0.0.1:6379` instead. This affected `BullMQTransport` and `runRedisWorker` / `startRun` (which `DurableModule`'s `connection` option feeds). The URL's host, port, credentials, db and TLS are read; query parameters are refused. New `redisUrlToOptions` / `normalizeRedisConnection` exports in `@dudousxd/durable-worker`.
  - New `BullMQTransport.deferConsumers()` / `startConsumers()` and a `deferConsumers` option. They park every point-to-point consumer (tasks, results, decisions, step events, start-run, run-request), and the worker-liveness advertisement, until started.
  - New `DurableModule` option `consumers: false` for producer-only processes (CLI commands, REPLs, scripts). It defers the transports' consumers before the engine subscribes and starts no co-located or thin worker consumer. The default is unchanged.

## 0.22.2

### Patch Changes

- [#387](https://github.com/DavideCarvalho/nestjs-durable/pull/387) [`d075b35`](https://github.com/DavideCarvalho/nestjs-durable/commit/d075b351e77dbb4da3eaac534969f1d42547f985) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Adaptive concurrency controller fixes:

  - `throughputPerMin` on the worker heartbeat is now a rate over the trailing minute. It decays while a worker sits idle and reads 0 once a minute passes with no completion, instead of reporting the last burst's rate forever.
  - In fixed mode (`concurrency` is a plain number) the controller no longer runs its control-loop timer. The limit stays the fixed value; the heartbeat snapshot samples CPU itself, at most once per 2s, so `cpuPct` is still reported.
  - `AdaptiveController` takes optional `readCpuUsage` and `readCpuCount` readers (defaults `process.cpuUsage()` and `os.cpus().length`), so the CPU ceiling can be driven in tests. A non-finite core count falls back to 1.

## 0.22.1

### Patch Changes

- [#377](https://github.com/DavideCarvalho/nestjs-durable/pull/377) [`b02f7ad`](https://github.com/DavideCarvalho/nestjs-durable/commit/b02f7adb7bd1ac85c8d9c030f6e3c738de10dbe9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A `concurrency` that is not a finite number of at least 1 falls back to its default instead of reaching BullMQ, which throws on it. The adaptive config gets the same guard: a bad `min`, `max`, `start` or `tickMs` uses its default (a `NaN` `tickMs` ran the control loop every millisecond), a bad `ramCeilingPct` uses 85 (a `NaN` one never braked), and a bad `cpuCeilingPct` turns the CPU ceiling off. Fractional counts are rounded down.

## 0.22.0

### Minor Changes

- [#368](https://github.com/DavideCarvalho/nestjs-durable/pull/368) [`6588790`](https://github.com/DavideCarvalho/nestjs-durable/commit/6588790f6845318c40f8cc9f3eb1648c09a4fd20) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Throughput for wide fans.

  - **`BullMQTransport({ resultConcurrency })`.** Sets how many step results an instance handles at once (default 1). Each result resumes its run inline, so with one at a time a wide fan's results queued up behind a single run turn per pod.
  - **One run's resumes go in order on an instance.** Settling results still runs in parallel. Only the resume each result triggers — the run's turn — is serialized per run on an instance, so the results of one wide step fan don't queue behind each other, and different runs proceed in parallel. A result resumes its run inline, and `execute` admits an instance into a lease it already holds, so two results of one run handled together ran two turns of that run concurrently. That already happened with an in-process transport, which delivers results concurrently, before this option existed.
  - **Due timers come in batches.** `listDueTimers(nowMs, namespace, limit)` returns the most overdue first, at most `limit`. The engine's `resumeDueTimers` loads at most `timerBatchSize` (a new engine option, default 500) per pass and walks it in a shuffled order. Every driving instance runs that pass each tick, so a wave of thousands of due runs — a recovery after an outage, a fan's children waking together — had every instance load all of it and contend for the same leases row by row.
    - All five bundled stores implement `limit` and the ordering, and the shared store contract covers both. A custom store that ignores `limit` still works; the engine then gets the whole due set as before.

### Patch Changes

- [#370](https://github.com/DavideCarvalho/nestjs-durable/pull/370) [`56f10e3`](https://github.com/DavideCarvalho/nestjs-durable/commit/56f10e3601f9d00e2c4a8e6f80ac02c921bcbd68) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `timerBatchSize` and `resultConcurrency` fall back to their defaults (500, 1) for a non-finite or sub-1 value. Before, `NaN` passed straight through `Math.max`, and a `NaN` timer batch stalled timer recovery on every tick.

## 0.21.3

### Patch Changes

- [#363](https://github.com/DavideCarvalho/nestjs-durable/pull/363) [`8aa3c3e`](https://github.com/DavideCarvalho/nestjs-durable/commit/8aa3c3ecd5753ffee7826fee31fe715b98a45371) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A step result is no longer overwritten back to `pending`. A turn that stamps a pending step's redispatch deadline (or re-dispatches it) wrote the row it had read a moment earlier. If the worker's result landed in between, the step went back to `pending` with no result, the run parked until the deadline, and the step ran a second time.

  - `StateStore.saveCheckpointIfPending` (optional, new) writes only while the stored row is still `pending` and reports whether it wrote. The engine uses it for the redispatch stamp, the redispatch itself, and for settling a step from its result, which also drops a duplicate delivery of the same result. A store without it falls back to `saveCheckpoint`. The MikroORM and in-memory stores implement it, and the shared store contract covers it.
  - BullMQ result jobs are retried (5 attempts, exponential backoff) when the engine's handler throws, failed ones are kept for 24h instead of deleted, and a result given up on is logged. Before, one store error at peak load dropped the result silently.
  - Two starts of the same run id that race between `start`'s existence check and its insert now converge on the winner's run. Before, the loser threw on the primary key; for a `ctx.all`/`ctx.child` child that throw was reported to the parent as "child failed to start", so a child that ran and completed failed the parent's fan.

## 0.21.2

### Patch Changes

- [#356](https://github.com/DavideCarvalho/nestjs-durable/pull/356) [`dbe222d`](https://github.com/DavideCarvalho/nestjs-durable/commit/dbe222de4ac8be195ac9bfd7049e4af3169abaa0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Closing while a pub/sub subscribe is still queued no longer raises an unhandled "Connection is closed." rejection; other subscribe/unsubscribe failures are logged (the worker control channel carries cancellations, so its failure is now visible). `BullMQTransport.close()` now closes workers first and the queues after them, under one `closeTimeoutMs` deadline, so a job finishing during SIGTERM can still publish its result instead of failing with "Connection is closed.".

## 0.21.1

### Patch Changes

- [#353](https://github.com/DavideCarvalho/nestjs-durable/pull/353) [`314c13e`](https://github.com/DavideCarvalho/nestjs-durable/commit/314c13efa7820c95a15eb710bce3f18c0af158ee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Support ioredis 6 and bullmq 6 alongside 5: the `ioredis` / `bullmq` peer ranges are now `^5.0.0 || ^6.0.0`, and the packages are built and tested against ioredis 6.0.0 + bullmq 6.3.17.

  The only code change is a type-level one. ioredis 6 types `RedisOptions.replyMapping` as `T | undefined` but its constructor overloads as `replyMapping?: T`, so under `exactOptionalPropertyTypes` a plain `RedisOptions` matched no `new Redis(...)` overload; `BullMQTransport` and `RedisAdmissionBackend` now narrow that one key away at the call site. Runtime behaviour is unchanged, and none of bullmq 6's removed APIs (legacy repeatables, `Queue#client`, `Worker#blockingClient`, the `paused` job state, `debounce`, `Job#discard`) were in use.

  Note that ioredis 6 speaks RESP3 by default; the transport's pub/sub, PING watchdog, SCAN/GET and the admission Lua script all behave the same under it. Pass `protocol: 2` in your connection options if you need the v5 wire protocol.

## 0.21.0

### Minor Changes

- 4c62762: A live worker is visible even when it announces nothing, and a version pin can fail

  `announcedWorkflows()` read only the descriptor advertisement, so a fleet whose SDK predates the
  handshake reported as EMPTY while it was serving work — and `resolveRemoteByConvention`, in the same
  class, was routing calls to those workers off the heartbeat keys the registry ignored. Two answers
  out of one Redis, disagreeing.

  - The heartbeat keyspace is now a second, weaker tier of evidence. An entry exists because a live
    token of that name exists, which is exactly the condition convention routing uses, so listing it
    cannot introduce a failure the dispatcher did not already have. `AnnouncedWorkflow.evidence` says
    which tier an entry rests on: an `'observed'` entry states no version, origin or runtime, because
    a heartbeat holds none of them. A token some worker DECLARED as a step handler is excluded — that
    is a stated negative an observation cannot supply for itself.
  - `engine.workflowDirectory()` adds what a list can never say: whether it is empty because nobody
    asked (no transport here can introspect), because nothing is live, or because the workers are on a
    partition this engine does not route to — the last of which reads identically to absence from the
    caller's side and is now reported instead.
  - `Transport.readAllWorkerHeartbeats()` (optional, implemented by the BullMQ transport) is the read
    behind it: one scan of the liveness keyspace, keeping the instance behind each token.
  - A convention-resolved remote records the version the FLEET declares. `start` used to stamp the
    synthetic run `'1'` before resolving it and the resolver echoed that straight back, so a pin of
    `'1'` could never fail and any other value could never pass. When nobody declares a version the
    routing default is kept — refusing would make an un-upgraded callee uncallable — and the run
    carries the `version:undeclared` tag so a later check can tell an assumed version from a stated
    one. Resume is unchanged: replay is positional, so an in-flight run stays on the version it began
    on.

## 0.20.1

### Patch Changes

- d64a1ee: Stop `BullMQTransport.close()` from hanging forever on a wedged worker

  A graceful BullMQ `Worker.close()` waits for the current job **and** for the blocking connection to be
  released, and when the worker is still coming up — which is what a CPU-starved box produces — that
  wait has no upper bound. Because the transport awaited those closes one after another and only ran
  its `disconnect()` calls afterwards, a single wedged worker meant the remaining workers were never
  asked to close, the Redis sockets were never dropped, and `close()` never resolved. Every caller
  above it inherited that: in NestJS, `WorkflowRegistrar.onApplicationShutdown` → `app.close()`.

  It is bimodal, not slow. In one measured run 20 transports closed in 4–46ms (median 5ms) and 3 sat in
  `close()` for 120s, which was only where the probe stopped waiting.

  `close()` now:

  - races the graceful closes against a new `closeTimeoutMs` option (default `5_000`, `0` to skip the
    wait entirely);
  - issues them concurrently instead of sequentially, so one wedge no longer blocks the others;
  - always reaches the `disconnect()` calls, which is what actually lets the process exit.

  Escalating to `close(true)` is deliberately not attempted: BullMQ memoizes the close promise
  (`if (this.closing) return this.closing`), so a forced call after a graceful one returns the same
  pending promise and forces nothing.

  No behaviour change on a healthy close — it completes in single-digit ms, far inside the budget.

## 0.20.0

### Minor Changes

- 6402915: Let a deployment answer "what workflows exist here", from what workers announce.

  A console that offers "call this existing workflow" needs a picker, and nothing could build one.
  `engine.workflowBody(name, version)` answers only for the process asking, and a missing body is
  ambiguous BY DESIGN: it means "not registered here", but equally "registered via `registerRemote`
  against another SDK" or "a group this pod resolves by convention against a live worker". A picker
  built on that inference would show different options depending on which replica served the request —
  the same cross-replica incoherence a registry is supposed to remove.

  So registration is now ANNOUNCED. `WorkerDescriptor` gains an optional `registrations` — name,
  version, group, requires, origin — that a worker publishes for the bodies it holds and the queues it
  consumes. The rule is "announce only what you can run": nothing announces a workflow it merely knows
  how to route to, because that claim says nothing about a live executor existing. `runRedisWorker`
  (both the thin worker and the co-located in-app one) now publishes the full descriptor alongside the
  heartbeat it already stamped, and `@Workflow`'s `version`/`requires`/`origin` flow into it — the
  worker states what the decorator states, and an option left off stays un-stated.

  `engine.announcedWorkflows()` folds the live descriptors into one entry per `name@version`. It costs
  one scan of the advertisement keyspace PER CALL: nothing is added to the poll loop, and no pod holds
  a table of the fleet's registrations. It is namespace-scoped like every other poll surface, so an
  operator sees every tenant and a tenant engine sees only its own.

  LIVENESS is the descriptor key's TTL. The announcement rides a key written with the worker-heartbeat
  TTL and refreshed by the same beat, so a worker that dies takes its announcements with it — there is
  no expiry bookkeeping to get wrong, and no way for an announcement to outlive its worker. The
  resolution is the TTL, so an entry can name a worker that died within the last beat window; that is
  the staleness the capability router already accepts when it reads the same keys to decide dispatch.

  DISAGREEMENT is reported, never resolved. Two workers announcing one `name@version` from different
  groups, origins or capability demands produce ONE entry listing every distinct claim plus the axes
  they differ on. Two origins is a name collision between packages; two `requires` sets is two code
  versions under one version tag; two groups means nobody can know which queue to dispatch to. Each is
  a human's call, so the aggregate surfaces it instead of silently picking a winner. Silence is not a
  claim — an announcer that stated no origin does not disagree with one that did.

  CROSS-SDK, today. Every SDK already publishes `workflows: string[]`, and a bare name is accepted as a
  valid unversioned announcement, so a worker that has not adopted `registrations` is listed rather
  than invisible. The Python SDK publishes the richer form too (`@worker.workflow("pipeline",
version="2", origin="...")`), and its hash projection matches the TS one byte for byte — pinned by a
  new golden fixture both suites read. A descriptor that announces nothing hashes EXACTLY as before, so
  every ETag already published stays valid.

  STEPS are deliberately out of scope, and the reason is written down in `handshake/announced` and the
  handshake docs: a step is not addressable from outside a run — it has a `(runId, seq)` position in
  one workflow's history, `ctx.step` is only callable from inside a replaying body, and no engine entry
  point starts one on its own. "Call this step" is not an operation the engine can perform, so a picker
  offering steps would offer something that does not exist.

## 0.19.0

### Minor Changes

- 4bc86e4: **A dispatched step now routes by the RUN's tenant, not by the engine's.** This closes a tenant-isolation hole: an operator that had a workflow registered locally executed a tenant's run in-process and dispatched its steps to the BARE group token — so on a shared broker the deployed cluster's workers ran that tenant's work, reaching for the tenant's data in the wrong place.

  **core**

  - Every dispatched-step routing token is now `tenantGroup(sanitizeQueueToken(step.name), step.partition ?? run.namespace)` (the new internal `stepGroup`), applied uniformly across the durable dispatch, the re-dispatch, the `ensureRoutable` guard, the `timeoutMs` in-memory path, and saga compensations. Previously all of these read only `StepDef.partition` — a field no code path has populated since `remoteStep({ group })` was removed, so **every** step dispatched bare regardless of topology.
  - This restores the symmetry the wire always assumed: an out-of-process worker already stamps its own partition onto each `call` command it emits (the worker SDK's `resolveCallGroup`); the in-process executor had no equivalent. Now both derive the same token.
  - Child runs were already inheriting the parent's namespace — unchanged.

  **nestjs**

  - `topology: { role: 'control-plane', tenant }` now maps `tenant` onto the node's worker-routing `partition` as well as its `namespace`, so a tenant-scoped control plane SUBSCRIBES the same `<name>@<tenant>` tokens its engine DISPATCHES to. Without this the node would enqueue onto queues it is not itself consuming.
  - `DurableStepRegistrar` passes that partition when registering each `@Step` on the transport.
  - A node's serving `partition` now also falls back to its own `namespace` when not declared, so the documented local-dev recipe (a namespaced engine on a private Redis, `docs/namespaces.md`) keeps working end-to-end with no extra wiring. An explicit `partition` still wins.

  **transport-bullmq**

  - `handle(name, fn, partition?)` takes an optional per-registration partition that overrides the transport's constructor partition — a tenant-scoped control plane shares ONE transport for dispatch and for serving its handlers.

  **Visibility — a run stuck on an offline tenant now shows as `no-worker` in `/durable`.** `workerHealth()` now also covers the routing groups of in-flight **pending remote steps**, not just registered groups and live heartbeats. A step dispatched to a tenant pool that is offline sits in its queue (correct — the durable queue holds it and the worker consumes it the moment the tenant returns), but that queue was previously invisible to the health scan (no registration, no heartbeat), so the run rendered as "running". Now the scan sees the backlog-with-no-consumer and the dashboard shows the run as **no-worker** — the warm colour, the "N runs have no worker" banner. No dispatch behaviour changes; nothing is parked; recovery/self-heal are unchanged.

  **dashboard**

  - A `blocked` run (no capability/protocol-compatible worker) now renders as the existing **no-worker** display state (colour + attention banner) instead of a flat, uncoloured badge.

  **Compatibility.** `tenantGroup` maps `undefined` / `''` / `'default'` to the bare token, so a single-tenant deployment and every `default`-namespace run keep byte-identical wire names. The behavior changes only for runs stamped with a real tenant — which is the bug. If you set `namespace`/`tenant` purely as a store-partitioning axis while your workers subscribe BARE tokens (e.g. a local stack whose isolation actually comes from a private Redis or a distinct `prefix`), those steps now dispatch to `<name>@<tenant>`: give the worker the matching `partition`, or drop the tenant and keep isolating by transport `prefix`.

## 0.18.0

### Minor Changes

- 46b3ec4: Store-less cluster handshake & capability negotiation (wire-compatible with the Adonis `@adonis-agora/durable` port and the Python `durable-worker` client — proven with live bidirectional interop).

  **core**

  - New handshake layer: a worker advertises a two-tier `WorkerDescriptor` (a stable `descriptorHash` over its declared capabilities + supported workflow requirements) and the control plane runs `negotiate()`, classifying each worker as `compatible` / `degraded` / `incompatible`. Capability-aware dispatch routing parks a run as `blocked` when no capable/compatible worker is registered instead of hanging or dead-lettering it — the run resumes automatically once a matching worker appears.
  - `LEGACY_V1_CAPABILITIES` lets a pre-handshake worker (no descriptor) be treated as a known-capability baseline rather than rejected, so rolling upgrades never strand runs.

  **transport-bullmq**

  - The BullMQ transport now advertises the handshake descriptor over a `-worker-descriptor:<token>:<instance>` channel and the control plane consumes it during negotiation — byte-compatible with the aviary wire so an Adonis or Python worker can join the same control plane.

  **nestjs**

  - `@Step({ requires })` / `@Workflow({ requires })` capability-authoring surface: declare the capabilities a step/workflow needs so the handshake can route it only to workers that support them.

  Also guards the in-memory (`timeoutMs`) step-dispatch path so a capability mismatch there parks rather than silently mis-dispatches.

## 0.17.0

### Minor Changes

- 6d6b79c: Retry ergonomics + wedged-step ceiling.

  **core**

  - `requeue` now CASCADES: retrying a parent that failed on an awaited child also requeues that failed/dead child, so the dashboard "Retry" on the parent converges by itself (parent-only used to be instantly re-failed by the reconciler re-delivering the child's still-failed terminal state). Skipped when a SUCCESS is already buffered on the child's token (see below) — the origin isn't re-run for nothing.
  - `requeue` clears the stale `run.error`, so a re-executing run no longer shows its previous failure.
  - A `retry-with-input` run's SUCCESS is now also delivered on its ORIGIN's `child:<origin>` token: a parent that failed on that child and is retried later adopts the fix's result instead of waiting on a child nobody re-runs.

  **transport-bullmq**

  - New opt-in `stepTimeoutMs`: a wall-clock ceiling per step handler. A wedged handler (an await that will never settle) used to hold its BullMQ job forever — lock renewal is timer-based, so the job was never reclaimed. At the deadline the transport publishes a RETRYABLE failed StepResult (durable retry re-dispatches) and abandons the orphaned promise.

  **dashboard**

  - A still-pending step no longer shows a `finished` timestamp next to its running duration.

## 0.16.0

### Minor Changes

- 134b706: **One tenant encoding on the wire** — the engine's namespace no longer re-scopes the transport
  keyspace. Per-run tenant routing now has exactly ONE encoding, the cross-SDK canonical convention
  every worker runtime already speaks natively (the Python SDK, the TS tenant role): `@<tenant>`
  GROUP suffixes (`processing@dev-alice`) on the transport's own prefix.

  Previously a tenant-scoped control plane (`topology: { role: 'control-plane', tenant }`) auto-folded
  its namespace into the transport prefix (`durable-<tenant>-*`), encoding the tenant TWICE (prefix on
  the TS side, group suffix on the worker side) — two keyspaces that could never see each other, which
  is why the `tenantWorkers: 'bridge'` pairing existed. With the propagation removed, a scoped control
  plane lives on the same (bare) prefix as its tenant workers and reaches them natively: no bridge, no
  second transport, no config beyond `tenant`.

  The two axes are now fully orthogonal:

  - **`topology.tenant` / engine `namespace`** — STORE axis: which runs this operator drives/recovers,
    and the tenant stamped on runs it starts (routed as `@<tenant>` groups).
  - **Transport `prefix` / `namespace` (constructor options)** — whole-DEPLOYMENT isolation on a
    shared broker. Explicit only, never inferred from the engine.

  Breaking (0.x): removed `Transport.useNamespace` / `TransportPool.useNamespace` (nothing calls them
  — transports take their namespace at construction only), removed `Transport.withNamespace` and
  `BullMQTransport.withNamespace`, and removed the `tenantWorkers: 'bridge'` topology option (all
  introduced for the now-deleted double encoding; drop `tenantWorkers` from your config — `tenant`
  alone now does the whole job). A NAMESPACED BullMQ transport still refuses `@tenant` routing tokens
  loudly (that combination remains a double encoding — now it is always an explicit misconfiguration).

  Deployed operators (namespace unset) were never affected by the propagation: their wire names are
  byte-identical before and after.

## 0.15.0

### Minor Changes

- 79e1ea6: `topology: { role: 'control-plane', tenant, tenantWorkers: 'bridge' }` — one-line preset for the
  tenant-worker bridge. Instead of hand-wiring a two-member `transports` pool (scoped primary +
  bare-prefix secondary) behind an env-var conditional, a control plane declares that its tenant
  workers follow the operator convention and the preset builds the pool itself:

  ```ts
  DurableModule.forRoot({
    store,
    transport: new BullMQTransport({ connection }),
    topology: {
      role: "control-plane",
      tenant: process.env.DURABLE_TENANT, // undefined on deployed pods — bridge is INERT then
      tenantWorkers: "bridge",
    },
  });
  ```

  With `tenant` set, the configured `transport` (namespaced to the tenant by the engine) is paired
  with `transport.withNamespace('default')` — a bare-prefix sibling — so operator-convention tenant
  workers (`<group>@<tenant>` under the bare prefix: the Python SDK, the TS tenant role) are
  discoverable and dispatchable. With `tenant` unset the option is inert, so one static config serves
  both the scoped local stack and the global deployed operator. An explicit `transports` pool wins
  over the sugar; a transport without `withNamespace` fails fast at config time.

  - **transport-bullmq:** new `withNamespace(namespace)` — a sibling `BullMQTransport` on the same
    connection/prefix/partition, pinned to an explicit namespace.
  - **core:** optional `Transport.withNamespace?(namespace)` interface hook.
  - **nestjs:** the preset above; `TRANSPORT_CANONICAL` keeps feeding the step registrar with the
    singular `transport` (or falls back to the pool primary).

## 0.14.0

### Minor Changes

- cb7a104: Tenant-scoped control plane ⇄ operator-convention tenant workers: make the two tenant encodings
  interoperate through a mixed transport pool.

  A control plane scoped with `topology: { role: 'control-plane', tenant: X }` namespaces its
  transport keyspace (`durable-X-*`, bare group tokens), while tenant workers — the Python SDK and the
  TS `role: 'tenant'` worker — follow the OPERATOR convention: bare `durable-*` prefix with
  `@X`-suffixed groups (`processing@X`). The two keyspaces couldn't see each other, so a scoped local
  stack could never route a convention-resolved remote workflow to its own tenant worker: the group
  was reported "not registered" (and, combined with the swallowed child-start failure, the parent hung
  suspended forever).

  - **core:** `TransportPool.transportWithLiveGroup(group)` — convention resolution
    (`resolveRemoteByConvention`) now dispatches on the transport whose keyspace actually reports the
    live group, instead of blindly on `pool.primary`. Single-transport pools behave exactly as before.
  - **transport-bullmq:** a NAMESPACED transport now REFUSES to enqueue a `@tenant`-suffixed routing
    token (`dispatch`/`dispatchWorkflowTask`) with an error that names the fix — enqueueing it under
    the scoped prefix (`durable-X-tasks-<name>@X`) double-encodes the tenant axis onto a queue no
    worker anywhere subscribes. The loud throw lets a `TransportPool` fail over to a bare-prefix pool
    member. Un-namespaced (operator) transports and the `'default'` namespace are byte-identical to
    before.
  - **nestjs:** `assertValidRole` accepts `transports` (plural) wherever `transport` was required.

  The supported pairing: give the scoped control plane a pool of its (namespaced) primary plus a
  bare-prefix secondary — `new BullMQTransport({ connection, namespace: 'default' })` (explicit, so
  `useNamespace` never re-scopes it). Discovery, dispatch, results, decisions and heartbeats then
  reach operator-convention tenant workers on the bare prefix. Only pair the bare secondary on a
  PRIVATE broker: it consumes the shared bare control queues.

## 0.13.0

### Minor Changes

- 7dd8f45: Fix a permanent hang: `BullMQTransport`'s pub/sub subscriber connections (`onControl`,
  `onHeartbeat`, `onRunReply`, `onTenantEvent`) never write on their own, so when a VPN/NAT/idle
  timeout silently drops the underlying TCP connection, the server-side subscription is gone
  (`PUBSUB NUMSUB` shows 0) while ioredis's client-side socket still believes it's connected — no
  write ever fails, no timeout ever fires, and the connection sits half-open forever. Every control
  plane call (`listRuns`, cancel, etc.) then blocks until the process restarts.

  Adds a shared ping watchdog: every `pingIntervalMs` (new option, default `30_000`; pass `0` or
  `false` to disable), each subscriber connection this transport owns gets a `PING` (legal in
  subscriber mode). A rejection or timeout `disconnect(true)`s that connection, letting ioredis's own
  `retryStrategy` reconnect and `autoResubscribe` restore its channel — logging once on detection and
  once on successful resubscribe. Also attaches a de-duplicated `error` listener to every subscriber
  connection (an unhandled `error` event on an ioredis instance crashes the process in some setups),
  and applies a TCP keepalive floor to connections the transport builds itself as a secondary defence.
  The watchdog is a single shared interval (not one per connection) and is torn down in `close()`.

  Regression-tested against a real Redis (`bullmq-transport.db.spec.ts`) using a silent TCP relay that
  severs the server-side leg of a subscriber connection while leaving the client socket open and
  unresponsive — the same failure mode `CLIENT KILL` doesn't reproduce, since ordinary FIN/RST
  disconnects already recover via ioredis's own handling. Verified: without the watchdog the test
  times out; with it, `PUBSUB NUMSUB` recovers and a dispatched `RunReply` is delivered within ~500ms.

## 0.12.1

### Patch Changes

- da80cde: **Recover a remote step whose dispatched job was LOST.** A remote step with no `timeoutMs` dispatches
  its work, persists a `pending` checkpoint, and suspends until the result resumes it. If the worker
  crashed mid-step (no result) or the transport dropped the job (a Redis flush/eviction, or a stalled
  job moved to `failed` and removed), the result never came — and nothing re-dispatched it. Reconcile
  re-drives re-suspend a still-`pending` step by design, `recoverIncomplete` only reclaims leased runs,
  and the dashboard "retry" just replayed back to the same wait. So the run hung on `pending` forever.
  Four independent closes:

  - **`WorkflowEngine.redispatchPending(runId)` (core) + a "Re-dispatch" dashboard action** — the manual
    escape hatch: re-enqueues a run's stuck `pending` remote steps (bumping `attempts`) so the idempotent
    step re-runs and its result resumes the run. Exposed through `RunGateway` and over the tenant proxy.
  - **Opt-in self-heal `remoteRedispatchMs` (core)** — when set, a reconcile re-drive that finds a remote
    step still `pending` past this window re-dispatches it (a clock-space deadline stamped on the
    checkpoint, stable across replays), bounded by `remoteRedispatchMax` (default 10) so a step that never
    settles fails as a `remote_step_lost` error instead of looping. Off by default: re-dispatch can
    double-run a merely-slow step, so the window must exceed the longest such step and steps must be
    idempotent. Prefer a per-step `timeoutMs` where you can; this is the store-driven net for the
    no-timeout steps that must survive a lost dispatch.
  - **BullMQ transport bridges a terminal job failure (`transport-bullmq`)** — a crashed/stalled task job
    now publishes a synthetic failed `StepResult` (via `Worker.on('failed')`), so the engine marks the
    checkpoint `failed` and its normal durable retry re-dispatches — instead of the run hanging on
    `pending`. Requires retaining the failed job's payload briefly (`removeOnFail: { age }`) so the bridge
    can read the task identity before BullMQ GCs it. A handler business-error still succeeds the job (it
    already publishes its own failed result), so there is no double-publish.
  - **Stale-pending visibility (dashboard)** — a remote step `pending` past `STALE_PENDING_MS` (10 min) is
    flagged in the timeline ("awaiting worker result — dispatched Nm ago (possibly lost)") instead of
    masquerading as a healthy in-flight step, so an operator can see and re-dispatch it.

## 0.12.0

### Minor Changes

- ec56a9c: Route durable work by **handler name** instead of a declared `group`, and rename the isolation axis to `partition`. The API surface shrinks and the common case needs no `group`/`groups` ceremony.

  - **`ctx.remote(step, input)`** is the remote-step dispatch method; **`ctx.call` is a deprecated back-compat alias** of it (identical dispatch).
  - **`RemoteStepDef.group` is replaced by optional `RemoteStepDef.partition`.** Routing is now keyed by the step's `name`; `partition` is only an isolation suffix. `remoteStep({ group })` is a deprecated alias mapped onto `partition`. The dispatched queue token is `tenantGroup(sanitizeQueueToken(name), partition)` (new `sanitizeQueueToken` replaces `:` with `-`, which BullMQ forbids in queue names; exported from the package root).
  - **Workers subscribe per registered handler name, not per group.** `DurableWorkerModule` derives its subscriptions from the discovered `@Workflow`/`@Step` — `groups` is now optional/deprecated (ignored) and `tenant` is a deprecated alias for the new `partition`. `BullMQTransport` starts one consumer per registered handler (its `group` option is a deprecated alias for `partition`). The thin `runRedisWorker` and `DurableWorkerRuntime.registeredNames()` back this. In-app group-served workflows dispatch each turn under their own name-derived token.
  - **Execution model is unchanged** (stateless replay-per-turn) and now regression-locked.

  Migration is non-breaking via the deprecation aliases above — each consumer's source migrates independently. **The wire format (queue naming) is a coordinated atomic change:** the durable fleet (operator + every runtime worker, JS and Python) must deploy together for this release, as it already must for any routing change.

  **Known limitation (follow-up):** only `BullMQTransport` is migrated to per-handler subscription. `DbTransport` and `SqsTransport` still use the flat single-`group` consumer model (they interoperate with the new engine because dispatch carries the computed token, but a worker instance serves one token, not one-per-handler). SQS additionally rejects `.` in queue names, which `sanitizeQueueToken` does not strip. Migrate these if/when needed.

- 988ec4c: Collapse the local/remote step split into ONE durable step primitive (breaking, 0.x).

  - **One `ctx.step`, always dispatched, always engine-scheduled.** `ctx.step(handlerRef | name, input, opts?)` is the only step primitive — no author-facing placement choice. Pass a `@Step`-decorated method **reference** (name + types read off the stamped method — refactor-safe, autocompleted) or a **name string** for a cross-runtime handler (e.g. a Python `@step`). Both forms emit the identical dispatch; a step runs on whatever worker serves that name. Crossing a _workflow_ boundary is unchanged — still `ctx.child`.
  - **`@Step` carries the identity.** `@Step()` derives the routing name from the method (`Class.method`); `@Step('custom:name')` overrides it; `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?, backoffMaxMs?, jitter?, timeoutMs? })` adds opt-in runtime zod validation and a **declared retry/timeout policy** the engine applies to every dispatch of that step. `StepDispatchOpts` (the per-call `ctx.step(..., opts)` third argument) can override any of `retries`/`backoff`/`backoffMs`/`backoffMaxMs`/`jitter`/`timeoutMs` field-by-field on top of the `@Step`-declared value, plus the existing `queue`/`priority`/`fairnessKey`/`transport`.
  - **New deterministic-capture primitives.** `ctx.sideEffect(fn)` runs `fn` once, checkpoints the result, and replays the SAME value thereafter (Temporal's `sideEffect`) — the author picks the generator: `ctx.sideEffect(() => uuidv7())`, `() => ulid()`, `() => Math.random()`, a config/env read. `ctx.now()` returns epoch **ms** (like `Date.now()`), the one ubiquitous convenience kept as a lightweight built-in.
  - **Removed, no deprecation aliases:** `ctx.remote` (→ `ctx.step`), the inline `ctx.step(name, closure)` form (→ a `@Step` method dispatched via `ctx.step(this.svc.method, input)`, or `ctx.sideEffect`/`ctx.now()` for a non-dispatched capture), `remoteStep()` and `RemoteStepDef` (identity now lives on the `@Step` method itself — nothing to declare separately), `ctx.uuid()` and `ctx.random()` (→ `ctx.sideEffect(() => ...)`, so the algorithm is exactly what the author chooses). `@DurableStep` stays as a back-compat alias of `@Step` (unaffected).
  - **`@dudousxd/nestjs-durable-eslint-plugin` / the GritQL rule** flag differently: a closure is only treated as checkpointed inside `ctx.sideEffect(...)`/`ctx.task(...)` now (no longer `ctx.step(...)`, which never takes a closure), and the `useRandom`/`useUuid` messages point at `ctx.sideEffect(() => ...)` instead of the removed `ctx.random()`/`ctx.uuid()`.

  No wire/history/protocol change — `ctx.step` emits the same `{ kind: 'call', seq, name, group, input }` decision and `Suspend` that `ctx.remote` emitted, so route-by-handler, partitioning, convention dispatch, and `gather`/`all` fan-out are unchanged; only the authoring surface moved. The durable fleet (engine + JS/Python workers) adopts the new surface together, as every prior routing/surface cut required. Python's `durable-worker` (PyPI) gets the same cut — `.step(name, input)` always dispatched, `.now()`/`.side_effect(fn)` added, `.call`/baked uuid/random removed — bumped separately on PyPI, not through this changeset.

- 6f24040: Collapse the role-declaration surface and drop the Phase-1 deprecation aliases (breaking, 0.x).

  - **One module, role inferred.** `DurableModule.forRoot(options)` is the only entry point. `{ store, transport }` → operator (engine + store + drivers, executes bodies inline). `{ connection }` (no store) → thin worker (store-less start client + `ProxyRunGateway` + one queue subscribed per registered `@Workflow`/`@Step`). `{ store, transport, connection }` → operator that dispatches its own bodies to a co-located per-name worker (uniform dispatch). `partition?` is the only isolation knob; `drive?` (default true for an operator) stays for read-only store replicas. **`DurableWorkerModule`, `DurableControlPlaneModule`, and the `inAppWorker` option are removed** — folded into `DurableModule`.
  - **Convention dispatch is the default.** The `remoteByConvention` flag is removed: an operator with no local body for a workflow and a live worker of that name dispatches to it automatically (route-by-name makes it correct by construction); an unknown workflow still throws `not registered`.
  - **Deprecation aliases removed.** `ctx.call` (use `ctx.remote`), `remoteStep({ group })` (use `partition`), `DurableWorkerModule` `groups`/`tenant`/`concurrencyByGroup`, `BullMQTransport({ group })` (use `partition`), Python `Worker(group=/tenant=)` (use `partition`). Python bumped to `0.21.0b0`.

  Canonical config is now two shapes: operator `{ store, transport }`, worker `{ connection, partition? }` — everything served is derived from the `@Workflow`/`@Step` decorators. Breaking cut; the durable fleet (operator + JS/Python workers) adopts the new surface together, as it already must for any routing change.

- ecce3ca: Implement `dispatchStartRun` and `onStartRun` on `BullMQTransport` (P4). Messages are enqueued on `<effectivePrefix>-start-run`, respecting the existing namespace-prefix rule. Both methods follow the same BullMQ queue plumbing (`removeOnComplete`/`removeOnFail`, same JSON serialisation) as the existing tasks/results/decisions queues.
- b4b8b73: Tenant run gateway: a store-less tenant worker can now read (getRunDetail/listRuns), control
  (cancel/retry/continue/retryWithInput), and live-stream its OWN runs over the shared transport, via a
  new `RunGateway` port. The control plane binds a store-backed gateway and answers tenant requests —
  scoped to the tenant's namespace — over a new run-request queue plus run-reply and per-tenant-event
  pub/sub channels; a tenant binds a `ProxyRunGateway` (given an app-supplied transport). No store and no
  HTTP on the tenant side; every request is namespace-scoped so a tenant can never read or act on another
  tenant's run. `EngineEvent` now carries an optional `namespace` (stamped on `run.*` lifecycle events)
  so the control plane can re-publish a run's events to its owning tenant.

## 0.11.0

### Minor Changes

- 69ed5b1: feat: namespace now partitions the transport, not just the store

  A durable `namespace` already isolated the STORE (a worker only recovers/resumes/times-out runs in its
  own namespace). It now ALSO partitions the BullMQ TRANSPORT: every queue/stream/key name is derived
  from the namespace, so multiple logical deployments can safely share ONE Redis — a developer running
  locally against a shared Redis no longer collides with (or steals tasks from) the deployed workers, and
  vice-versa.

  - `BullMQTransport` gains a `namespace` option. All names (`<prefix>-tasks-<group>`, `-results`,
    `-decisions`, `-step-events`, the `-worker-heartbeat:` key, and the `-control` / `-heartbeat` channels)
    become `<prefix>-<namespace>-...` for a non-default namespace. A namespace that is unset or `"default"`
    → names are BYTE-IDENTICAL to before (production unchanged).
  - The engine propagates its own `namespace` to the transport via a new optional `Transport.useNamespace`,
    so you set the namespace ONCE on the engine. An explicit namespace passed to the transport's
    constructor still takes precedence.
  - The Python `durable-worker` gains a matching `namespace` param with the identical derivation
    (`prefix-namespace` for non-default), so a Python worker joins the same namespaced queues. Published
    separately as `durable-worker` 0.17.0.

  Pair the existing store `namespace` with this to get full two-axis isolation on shared infra:
  namespace → store, namespace-derived prefix → transport.

## 0.10.0

### Minor Changes

- 52a3e67: Unified worker / one group — a much smaller surface for the "workflow + its steps" model.

  - **`engine.remote(name, { group })`** — convenience form of `registerRemote`: it builds the broker
    `RemoteWorkflowExecutor` for you, so a remote (e.g. polyglot/Python) workflow is one line instead of
    hand-wiring an executor. `registerRemote` stays as the low-level escape hatch.
  - **Steps inherit the workflow's group.** A `ctx.call` / `gather_calls` with no explicit group now
    dispatches to the **workflow's own group** (explicit group still wins). This is what lets a workflow
    and its steps collapse onto ONE group / ONE worker — no more "two groups for one workflow". The two
    recon facts that make this cheap: workflow turns and step calls already share one queue
    (`<prefix>-tasks-<group>`, job-name discriminated), and the worker runtime already routes both.
  - **`@Step` decorator** (NestJS) — `@DurableStep` is renamed to `@Step` (kept as a deprecated alias),
    aligning the name with the Python `@worker.step`. `@Workflow` unchanged.
  - **Adaptive concurrency measures only steps.** With one worker carrying both turns and steps on a
    single pool (correct — turns suspend, they don't block), the adaptive controller's latency/throughput
    window now counts only step completions, so a fast workflow turn can't corrupt the gradient.
    `AdaptiveController.onSettle` gains a `kind: 'workflow' | 'step'` argument.

  The Python `durable-worker` client gains the matching unified `Worker` (one worker holds both
  `@worker.workflow` and `@worker.step` on one group; `WorkflowWorker` kept as a deprecated alias for the
  opt-in split). Released separately (0.16.0). See `docs/workers-when-to-use.md`.

## 0.9.0

### Minor Changes

- 4eace00: Observable + adaptive workers. Workers can now self-tune their concurrency and publish a live status
  snapshot on their heartbeat, surfaced per worker in Telescope and the embedded dashboard.

  - **Adaptive concurrency.** The `concurrency` option on every worker surface
    (`BullMQTransport`, `runRedisWorker`, the NestJS in-app worker, the multi-group worker module, and
    the Python `Worker`) now also accepts `'adaptive'` or `{ mode: 'adaptive', min, max, start,
ramCeilingPct, cpuCeilingPct, tickMs }`. A control loop tunes the BullMQ Worker concurrency by an
    AIMD latency-gradient (grows only when saturated, shrinks when latency inflates = queuing), with a
    cgroup-aware RAM ceiling as a hard brake and backpressure on error/stall. A plain number stays
    fixed (default 1) — unchanged. No new dependencies (RAM/CPU read from stdlib + cgroup files).
  - **Worker status on the heartbeat.** The worker-liveness heartbeat value goes from a bare timestamp
    to `{ ts, status }` JSON carrying a `WorkerStatus` (new core type): concurrency mode + live limit,
    in-flight, RSS%, CPU%, throughput/min, p95 latency, and the adaptive controller's last limit change
    (`grow`/`shrink`/`ram_ceiling`/`backpressure`/`cpu_ceiling`). Readers accept both the new JSON and
    the old bare-timestamp form, so a mixed-version fleet reports cleanly.
  - **Telescope + dashboard.** A new `durable.workerStatus` data provider and a "Workers" panel show one
    row per live worker (mode, limit, in-flight/limit saturation, queue depth, RAM%, CPU%, throughput,
    p95, last adjust). The embedded dashboard's worker chips expand to a per-worker breakdown. The
    existing group-level "Worker health" panel is unchanged.

  Note: `@dudousxd/nestjs-durable-transport-bullmq` now depends on `@dudousxd/durable-worker` (it reuses
  the shared adaptive controller). The Python `durable-worker` client gains the same `concurrency`
  knob and status payload (released separately via git tag).

  See `docs/workers-when-to-use.md`.

- e228dcd: Add a `concurrency` option to every worker surface (BullMQ Worker concurrency). Defaults to 1
  (unchanged), so a fanned-out batch — e.g. the N remote steps of a `gather` — can run in parallel
  instead of serially. Available on `BullMQTransport({ concurrency })`, `runRedisWorker({ concurrency })`,
  the NestJS in-app worker (`concurrency`), and the multi-group worker module (`concurrency` +
  per-group `concurrencyByGroup`). The Python SDK gains the same knob (`Worker(concurrency=…)`).
  Total parallelism is `concurrency × replicas`. See `docs/workers-when-to-use.md`.

## 0.8.0

### Minor Changes

- f273457: Dispatch priority now reaches the broker, end-to-end.

  - `ctx.call(step, input, { priority })` and `ctx.child(workflow, input, { priority })` carry their
    priority onto the dispatched `RemoteTask` / `WorkflowTask`. The third arg of `ctx.child` /
    `ctx.startChild` accepts `{ childId?, priority? }` (a bare string is still shorthand for `childId`).
  - The BullMQ transport forwards that priority to the job's `priority` option, translating the
    engine's "higher = more urgent" scale onto BullMQ's inverse "lower = more urgent" so one convention
    holds end-to-end. Jobs without a priority keep the FIFO default path.
  - `WorkflowRun.priority` is persisted by every store adapter (MikroORM, Drizzle, TypeORM, Prisma) so
    the priority survives the store round-trip that precedes each remote-workflow advance. Additive,
    nullable column — auto-schema/self-heal adds it to existing tables.

## 0.7.0

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

## 0.6.0

### Minor Changes

- 4a9de4a: Live per-step observability for remote (polyglot) workflows. A Python `@workflow` runs its `ctx.step`s inline over a single turn that can last minutes, so previously the engine learned of the steps only when the turn ended — the dashboard showed "no steps yet" the whole run, and when they finally landed they had a 0ms duration and no sub-process trail.

  The worker now streams each local step's lifecycle as it happens, over a dedicated point-to-point `<prefix>-step-events` queue (a single engine instance consumes each event and checkpoints it once — no cross-pod duplicate writes):

  - **core**: `WorkflowStepEvent` + `Transport.dispatchStepEvent`/`onStepEvent`; the engine persists a `running` checkpoint when a step's body begins and resolves it to `completed`/`failed` with the step's real wall-clock window and its sub-process/log `events`. The turn's final `recordStep` command now also carries `startedAt`/`finishedAt`/`events` and `applyCommands` honors them, so the idempotent turn-end persist matches the live one (real duration, not 0ms).
  - **transport-bullmq**: implements `dispatchStepEvent`/`onStepEvent` over the `<prefix>-step-events` queue.

  Result: each handler step appears `running` the moment it starts, then `completed`/`failed` with a true duration and its p-processes shown under it — live, not all at once at the end.

## 0.5.0

### Minor Changes

- 00c4f5f: Worker-health observability: surface per-group queue backlog vs. live workers, so "a worker is alive but consuming nothing" stops being silent.

  - **transport-bullmq**: a worker stamps a TTL'd liveness heartbeat (`<prefix>-worker-heartbeat:<group>:<instance>`, refreshed every 10s / 35s TTL) while it's consuming — the key expiring is the signal it died or stalled. Mirrors the Python SDK's heartbeat key, so a mixed-language group reports all its workers together. Adds `groupHealth(group)` (queue depth via `getJobCounts` + live workers via a non-blocking `SCAN`) and `listWorkerGroups()` (discovers groups from the heartbeat keyspace).
  - **core**: `WorkerHeartbeat`/`GroupHealth` types + an optional `Transport.groupHealth`/`listWorkerGroups`. `WorkflowEngine.workerHealth()` aggregates health across the engine's registered groups (so a registered group with backlog and ZERO workers still reports — the alert case) UNION the groups discovered from live heartbeats (so a local-step group surfaces once its workers beat).
  - **dashboard**: a `/workers` API endpoint + a header "Workers" panel — one chip per group showing live-worker count and backlog, turning red on `depth > 0 && liveWorkers === 0`. The Prometheus `/metrics` scrape also emits `durable_group_queue_depth` and `durable_group_live_workers` gauges, so the same signal can drive an alert rule.

## 0.4.0

### Minor Changes

- 419facb: Carry remote workflows over the transport: `Transport.dispatchWorkflowTask` / `onDecision` (optional),
  implemented by `BullMQTransport` (dispatch a WorkflowTask on `<prefix>-tasks-<group>`, consume decisions
  on `<prefix>-decisions` — the queues the Python `durable-worker`'s `run_redis_workflow_worker` serves).
  New `RemoteWorkflowExecutor` implements `WorkflowExecutor` over a transport (correlates each turn's
  decision by `taskId`), so `engine.registerRemote(name, version, { group, executor })` drives a workflow
  authored in another SDK over Redis/BullMQ. Verified end-to-end live: a Python `WorkflowWorker` replays
  and the TS engine drives it across real Redis.

## 0.3.0

### Minor Changes

- e736e31: feat: BullMQ heartbeats over Redis pub/sub

  `onHeartbeat` is no longer a no-op: the BullMQ transport now carries worker heartbeats over a
  dedicated Redis pub/sub channel (`<prefix>-heartbeat`), mirroring the control plane. A worker calls
  `transport.heartbeat({ runId, seq, stepId, group })` while running a long step, and the engine — on
  any pod — resets that step's `timeoutMs` liveness window. (Only the in-memory `timeoutMs` path uses
  heartbeats; the durable-suspend path is unaffected.)

- 6836ace: refactor!: separate the control plane from the Transport

  `publishControl`/`onControl` are no longer part of `Transport`; they form a dedicated `ControlPlane`
  interface, and the engine takes a separate `controlPlane` dependency. This decouples cross-instance
  broadcast (lifecycle events + cancellation) from the point-to-point task transport, so you can run a
  dedicated control plane (e.g. Redis pub/sub) independent of how steps are dispatched. Broadcast-capable
  transports (event-emitter, BullMQ) implement `ControlPlane` too and can be passed as both; the NestJS
  module auto-wires the transport as the control plane when it qualifies, or accepts an explicit
  `controlPlane` option.

## 0.2.0

### Minor Changes

- **Transport control plane** — a broadcast pub/sub across all engine instances, unlocking the cross-pod features from the durability audit:

  - `Transport.publishControl(msg)` / `onControl(handler)` + a `ControlMessage` type. In-process transports (in-memory, event-emitter) broadcast locally; **BullMQ broadcasts over Redis pub/sub**. Optional — the engine degrades to local-only when a transport doesn't implement it.
  - **Cross-pod live-tail**: the engine now broadcasts lifecycle events, so a dashboard-only pod (`worker: false`) sees events from a run executing on a worker pod. The dashboard exposes `@Sse('runs/:id/stream')` and `durableClient.streamRun(id, onEvent)` — live updates without polling.
  - **Cooperative cancellation**: `engine.cancel(runId)` broadcasts the cancel; `engine.onCancel(fn)` lets a worker bridge abort in-flight work instead of finishing it just to have the result discarded. Events are deduped by originating `instanceId` so a broker echo doesn't double-deliver.
