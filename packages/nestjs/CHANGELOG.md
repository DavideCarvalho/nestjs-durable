# @dudousxd/nestjs-durable

## 0.53.0

### Minor Changes

- [#438](https://github.com/DavideCarvalho/nestjs-durable/pull/438) [`e01a27c`](https://github.com/DavideCarvalho/nestjs-durable/commit/e01a27c92c7eae891c976b831b0a5b7ff5b02224) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A run whose `workflow@version` is registered on no instance (the workflow was renamed or deleted with runs in flight) no longer loops forever. Once it has been due for `unregisteredWorkflowGraceMs` (default 24h, counted from its `wakeAt` for a parked run), it moves to `dead` with a `workflow_not_registered` error, fires `onDead` and reaches the dead-letter workflow. Before, every poll tick skipped it and logged `is not registered — keep the prior version deployed` again. A rolling deploy's skew, where the pod on the prior version picks the run up within seconds, is unaffected. Set `unregisteredWorkflowGraceMs: 0` to keep the old skip-forever behavior.

## 0.52.7

### Patch Changes

- [#429](https://github.com/DavideCarvalho/nestjs-durable/pull/429) [`8c52b4e`](https://github.com/DavideCarvalho/nestjs-durable/commit/8c52b4e6232954b6176b4294f378c1e6a41f2ccf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ProxyRunGateway` has `getRun`: a store-less pod reads a run without its timeline, through a new
  `getRun` run request the control plane answers from its store, after the same tenant check as every
  run-scoped verb. A caller that only needs a run's status no longer gets the whole run detail over the
  wire (about 8 KB for a 33-step run, against 0.26 KB). A control plane that does not know the verb
  answers with no data or an unsupported-request error, and the proxy then reads the run out of
  `getRunDetail` and keeps doing so for a minute, the way `getFanMembers` falls back.

## 0.52.6

### Patch Changes

- [#428](https://github.com/DavideCarvalho/nestjs-durable/pull/428) [`a8a059c`](https://github.com/DavideCarvalho/nestjs-durable/commit/a8a059c76ca9d61fc5f2e622e637df9a3d991f06) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A worker boots while its first timer poll is still running, and the buffered-signal sweep costs a few queries per page instead of one per row.

  - **Boot no longer waits for the first poll.** `TimerPoller.onApplicationBootstrap` (and `RetentionPoller`'s) started the first poll and awaited it. Nest runs every `onApplicationBootstrap` before the HTTP server listens, so a first poll held up by a backlog kept the pod from passing its readiness probe and the rollout failed. The first poll is now started in the background. Shutdown still waits for the poll in flight, bounded by `shutdownTimeoutMs`.
  - **`engine.sweepBufferedSignals()` decides a page set-based.** For each buffered `child:` row it used to read the parent's checkpoints with a `LIKE` on the checkpoint name, and nothing indexes `(run_id, name)`. On a 40,000-child parent that meant one scan of 40,000 rows per buffered row. Now it reads every parent's run row in one batch: a gone or finished parent condemns its rows with no checkpoint read at all. For each parent that is still open, it reads the checkpoints the child ids point to by `(run_id, seq)` on the primary key, one call per parent per page. A `ctx.all` child `<p>.all.<first>.<i>` settles at seq `first + i`, and its fan's fold is at `first` (for a fan in waves, at `first + k * W`, where `W` is the length of wave 0's fold). A read by name is left only for ids that name no seq (an onError handler, a `ctx.startChild` child whose signal is not at its spawn seq, a fan in waves whose wave 0 did not fold).
  - **The sweep has a time budget.** One call stops starting pages or parent reads after 250 ms of wall-clock time and resumes from there on the next tick. It still never runs concurrently with itself.
  - **The child-completion check on the write path reads by key.** `childCompletionNeedsBuffer` runs on every completion of a wide fan that finds no waiter. It now does `getRun` plus one `getCheckpoints` for the child's seq and the fold's, instead of a `LIKE` over the parent's checkpoints.
  - The shared store contract checks that one sweep of 500 buffered rows of a 4,000-checkpoint parent sends at most 10 statements. It sends 6 on SQLite, Postgres and MySQL; it was 504 before.
  - An opt-in MySQL harness (`packages/store-mikro-orm/src/buffered-sweep.harness.db.spec.ts`, `DURABLE_HARNESS=1 pnpm test:db …`) reproduces the shape that broke a rollout: a 40k-child parent, 20k of its children's completions buffered, 42k buffered rows, ~380k checkpoints and ~167k runs. It measures one sweep tick and the write-path check.

## 0.52.5

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

## 0.52.4

### Patch Changes

- [#424](https://github.com/DavideCarvalho/nestjs-durable/pull/424) [`2bc6b22`](https://github.com/DavideCarvalho/nestjs-durable/commit/2bc6b223691d96e7a01ec4bb822b422c191cf612) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Child completions no longer pile up in `durable_buffered_signals`. A run that finished with no parent waiter buffered its completion on `child:<runId>` unconditionally, unless its parent held a byte-identical `signal:child:` checkpoint. So every root run (a controller start, a schedule) left a row behind, and so did a child of a settled `ctx.all` fan of 100+ children (folded into one `fan:` checkpoint) or one whose parent's copy came back from a MySQL `json`/Postgres `jsonb` column with its keys reordered. Nothing ever read those rows.

  The engine now buffers a child's completion only when its parent can still consume it: the parent exists, is not completed or cancelled, and does not already hold the outcome (compared ignoring key order, and counting a folded fan). A new `engine.sweepBufferedSignals()`, called by the NestJS timer poller, deletes the `child:` rows that fail that test, including ones earlier versions left: a few pages of 500 per tick until a pass ends, then every ten minutes; skipped on a namespaced engine. Stores gain `listBufferedSignals` (paged by id, by token prefix) and `deleteBufferedSignals`, covered by the StateStore contract. No schema change.

  A parent that joins a child which already finished settles it at once: `ctx.child` (a caller-chosen id, or a spawn joined later) in the same turn from the child's run row, a fan's children with a placeholder from an earlier turn likewise (with `failFast` honoured), and any child whose deferred start (in-process or a remote `startChild` command) finds it already finished gets its completion re-delivered to the waiter it now has. Before, such a parent waited for the reconcile wake, or forever with reconcile off.

## 0.52.3

### Patch Changes

- [#417](https://github.com/DavideCarvalho/nestjs-durable/pull/417) [`27354f0`](https://github.com/DavideCarvalho/nestjs-durable/commit/27354f0073f78ce524a8d709fc44d1a4e1e4ee57) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A wake that lands while its run's turn is still executing on another instance is no longer lost until the run's `reconcileMs` wake (5 minutes by default).

  - **The wake is kept for the turn.** A wake that cannot take the run's lease because a turn of the run is executing elsewhere (a signal, a child's completion, a step result) records a durable request, and the instance running that turn takes it after it releases the lease and runs the next turn. Before, the instance that received the wake looked again once, found the turn still running and gave up. Runs waiting on a fan of children were covered by a re-check after the turn, but a run waiting on a signal, or on a `ctx.child` whose completion had been overwritten, waited for its reconcile wake.
  - **`ctx.child` writes its timeline placeholder before it starts the child.** A child that finished before the placeholder was written had its completion overwritten by it, and the parent then saw the child as still running.
  - The shared run-dispatch contract (`runRunDispatchContract`) checks a child's completion, a fan's completions and a signal landing mid-turn on the other instance, for every transport.
  - **The SQL transport retries a statement the database rolled back to break a deadlock** (`ER_LOCK_DEADLOCK` on MySQL, `40P01` on Postgres) when it queues, takes or deletes a run, and queues a batch in run-id order. Queueing a batch while another instance took or deleted the same runs could deadlock on MySQL: the starts then waited for the next poll and the wakes resumed on the instance that raised them.

## 0.52.2

### Patch Changes

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

## 0.52.1

### Patch Changes

- [#416](https://github.com/DavideCarvalho/nestjs-durable/pull/416) [`f0332dc`](https://github.com/DavideCarvalho/nestjs-durable/commit/f0332dcc095bd5fd77507e872a6ddb6e4991d986) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tenant tokens, follow-ups to `verifyTenant`:

  - `ProxyRunGateway` rejects with an exported `RunGatewayError` whose `code` is typed (`unauthorized`, `cross-tenant`, ...). It used to be a plain `Error` with an untyped `code`.
  - With a `tenantToken` provider, the request timeout now starts once the token has resolved, so a slow provider no longer eats into the control plane's deadline. A provider that rejects fails the request.
  - Documented that `VerifiedTenant.capabilities` is carried but not enforced by the responder yet.

## 0.52.0

### Minor Changes

- [#414](https://github.com/DavideCarvalho/nestjs-durable/pull/414) [`cf36269`](https://github.com/DavideCarvalho/nestjs-durable/commit/cf36269117d17d1e7f742378fe6e5ab9947ce987) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Signed tenant tokens for the store-less cluster, wire-compatible with Agora. A control plane can set `verifyTenant` (e.g. `hmacTenantVerifier(secret)`) on `DurableModule.forRoot`: the `tenant` on each incoming run request and start-run is then treated as a signed token, the tenant is derived from it, and an invalid, tampered or missing token gets an `unauthorized` error reply (run requests) or creates no run (start-runs). Tenant pods present their token with the new `tenantToken` option (a string, or a function called before every request), minted by `signTenantToken(tenant, secret, { ttlMs? })`. Tokens and the `unauthorized` reply are byte-identical to Agora's, so the two libraries interoperate. Both options are optional: without them the wire `tenant` is trusted verbatim, as before. An explicit `topology: { role: 'control-plane' }` without a verifier now logs a warning at boot; a plain operator boots silently. `ProxyRunGateway` errors now carry the reply's `code`.

## 0.51.0

### Minor Changes

- [#410](https://github.com/DavideCarvalho/nestjs-durable/pull/410) [`1b2ad79`](https://github.com/DavideCarvalho/nestjs-durable/commit/1b2ad7970a67fcaa188677ea759afaaa3919a6e9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `schedules` takes the workflow class: `{ key: 'daily-report', workflow: DailyReportWorkflow, cron: '0 2 * * *' }`, the same reference `ctx.child` and `engine.start` take. A registered name still works, for a workflow in another runtime.

  - `ScheduledWorkflow<typeof DailyReportWorkflow>` checks `input` against the class's `run`. The plain `ScheduledWorkflow` accepts any input, as before.
  - A schedule whose class isn't decorated with `@Workflow` makes the app fail to boot, instead of failing on every tick.

- [#411](https://github.com/DavideCarvalho/nestjs-durable/pull/411) [`1fb5681`](https://github.com/DavideCarvalho/nestjs-durable/commit/1fb5681eef1d0cb87bcc71d1573cbae402929008) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `runSchedules` catches up with `@adonis-agora/durable`:

  - **Fix: `jitter` no longer stalls the timer poll.** A schedule with `jitter` slept up to that long on every tick, even when its window had already fired, holding up due timers, retries and timeouts behind it. It now sleeps once per window, only when the window has no run yet.
  - Each engine remembers the windows whose run it has seen exist, so a window that already fired costs no store read on later ticks. Idempotency is unchanged: a window this process has not seen still goes to the store.
  - `runSchedules` returns only the run ids it started. It used to return the current window's id on every call for the rest of the window.
  - `ScheduledWorkflow.namespace` stamps the runs with a namespace instead of the firing instance's own, for a workflow only one pool can run.
  - `runSchedules` stops firing once the engine is draining. `WorkflowEngine.isDraining()` is public.

- [#403](https://github.com/DavideCarvalho/nestjs-durable/pull/403) [`6c881fd`](https://github.com/DavideCarvalho/nestjs-durable/commit/6c881fd2fa5c0d6d4138dc4e15c1738ac3957fdc) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Scheduling helpers for NestJS apps, without reaching into `-core`.

  - `scheduleRunIdAt(schedule, nowMs)` is now public. It returns the run id of a schedule's window at `nowMs`, so `engine.getRun(scheduleRunIdAt(dailyReport, Date.now()))` finds the run a schedule started, from the same `ScheduledWorkflow` object the module was given, without rebuilding the id from its key, cron expression and timezone.
  - `@dudousxd/nestjs-durable` re-exports `runSchedules`, `scheduleRunIdAt`, `scheduledRunId`, `prevCronFireMs` and the `ScheduledWorkflow` / `RunSchedulesOptions` types.

- [#409](https://github.com/DavideCarvalho/nestjs-durable/pull/409) [`1874fd5`](https://github.com/DavideCarvalho/nestjs-durable/commit/1874fd5ed5689fee67b1948af1f292d4bd16a458) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `SchemaValidationError`: schema failures are one error class, with the same codes, message and `details` as `@adonis-agora/durable`.

  - `@Workflow({ input, output })` and `@Step({ input, output })` throw a `SchemaValidationError` (exported from core, a `FatalError`), still with `code: 'invalid_input'` / `'invalid_output'`.
  - `details` changes from the issues array to `{ issues }`, and the error also has `.issues`. Each issue is `{ message, path: string[] }`; `path` is now always present (`[]` for an issue on the value itself). An alert or an onError handler reading `failure.error.details[0]` must read `failure.error.details.issues[0]`.
  - A rejected `ctx.upsertSearchAttributes` write throws a `SchemaValidationError` with `code: 'schema_validation'` (it was a plain `Error`), so it is never retried and can be routed. Its message is now `invalid workflow "<name>" ctx.upsertSearchAttributes: <key>: <message>`.
  - An onError route for `schema_validation` — `@OnError(SchemaValidationError)`, whose `static code` it is — also catches `invalid_input` and `invalid_output` when no route names them.

- [#408](https://github.com/DavideCarvalho/nestjs-durable/pull/408) [`1f262a6`](https://github.com/DavideCarvalho/nestjs-durable/commit/1f262a6a5d213240ee81eb7ef67163713430bd8c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@Workflow({ validateInput })` now receives the value the `input` schema parsed, not the input as sent: a `Date` from `z.coerce.date()`, a DTO instance. Without an `input` schema it still receives the input as sent. The run still stores the input as sent. This matches `@dudousxd/adonis-agora-durable`.

  A `validateInput` that relied on the raw shape (a date as a string, a field the DTO strips with `whitelist: true`) now sees the parsed shape.

## 0.50.0

### Minor Changes

- [#406](https://github.com/DavideCarvalho/nestjs-durable/pull/406) [`4d9e840`](https://github.com/DavideCarvalho/nestjs-durable/commit/4d9e8406948130b55de0072e1276bbe06666ddd3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stalled-run pager.

  - `engine.onStalled(listener)` reports stranded runs: a run untouched for `stalledAfterMs` (default 15 minutes) that is either suspended with no wake timer, or parked on an old pending remote step that nothing is leasing. `engine.sweepStalled()` does the sweep. It is throttled to one pass a minute, skipped while draining, a no-op without listeners, scoped to the engine's namespace, and it reports each stranded episode once per instance.
  - The NestJS timer poller calls `sweepStalled()` every tick on a driving operator. `DurableModule` gains the `stalledAfterMs` and `onStalled` options.
  - `engine.listStalledRuns(opts)` and the standalone `findStalledRuns(store, opts)` run the same query on demand.
  - CLI: `durable inspect --stale[=<duration>]` lists stranded runs (default threshold 15m), and `--namespace <ns>` narrows any listing.

## 0.49.0

### Minor Changes

- [#399](https://github.com/DavideCarvalho/nestjs-durable/pull/399) [`4919333`](https://github.com/DavideCarvalho/nestjs-durable/commit/4919333f126fc92ace478174ebe82bd8635e99d9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@Workflow({ input, output })`: the schema options `@Step` already had, now on the workflow too.

  - `input` and `output` accept a Standard Schema (zod 3.24+, valibot, arktype, …) or a class-validator DTO class. `@Step({ input, output })` accepts the same forms; it used to take zod only, and a zod schema older than 3.24 still works.
  - The input is checked at `start`, so invalid input creates no run. The run stores the input as it was sent. `run(ctx, input)` receives the parsed value (a `Date` from `z.coerce.date()`, a DTO instance), re-parsed before every turn, so a replay sees the same value the first execution did. The schema must be deterministic, and changing it means bumping the workflow's `version`.
  - `output` parses the value `run()` returns before the run completes and stores the parsed value.
  - A value that does not match fails with a `FatalError` (never retried) with `code: 'invalid_input'` or `'invalid_output'` and the schema's issues as `details`. A run whose stored input no longer parses fails with `invalid_input`.
  - `inputSchema` stays, as an alias of `input`. Setting both is an error.

  Behaviour changes for existing workflows and steps:

  - A workflow with `inputSchema` now receives a DTO instance in `run()`, not the plain object. Properties the DTO does not declare are stripped (`whitelist: true`), as they already were during validation.
  - `validateInput` no longer replaces `inputSchema`: when both are set, the schema is checked first and then `validateInput` runs.
  - A `@Step` whose input or output fails its schema throws a `FatalError` with `code: 'invalid_input'` / `'invalid_output'` instead of a `ZodError`, so it is no longer retried.
  - The error message for invalid input changed from `invalid input for workflow: …` to `invalid workflow "<name>" input: …`.

## 0.48.2

### Patch Changes

- [#398](https://github.com/DavideCarvalho/nestjs-durable/pull/398) [`696b5b9`](https://github.com/DavideCarvalho/nestjs-durable/commit/696b5b9cb4202cf4fcda7a6cb5ba84072803beea) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Follow-ups to the in-process run gate, settle compare-and-set and orphan-only recovery:

  - A run parked `blocked` releases its lease best effort, like every other settle path. A failing release no longer replaces the `blocked` outcome with the lease error (or surfaces as an unhandled rejection for a background turn).
  - Recovery on a store without `listOrphanedRuns` reclaims at most 500 orphans per pass (oldest first), the same bound as the store query, instead of every orphan at once.
  - `updateRunIf` with a patch that maps to no column is a pure compare on the Prisma and TypeORM stores, like the Drizzle and MikroORM ones: Prisma reported `false` on a match and TypeORM threw. The shared store contract gains a case for it.
  - `WorkflowService.waitForRun` accepts `until: 'terminal'` (it already forwarded it to the engine; the type now says so), which is what awaiting a delayed (`startAt`) run needs.

## 0.48.1

### Patch Changes

- [#394](https://github.com/DavideCarvalho/nestjs-durable/pull/394) [`e078eff`](https://github.com/DavideCarvalho/nestjs-durable/commit/e078effbee012b444558f5425db8d122c4c61c15) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - BullMQ consumer fixes, and a way to keep CLI/REPL processes from consuming.

  - `onDecision` delivers every decision to every handler registered on the transport. It used to keep only the first, so a second engine sharing the transport never received decisions.
  - `onResult` delivers every result to every handler, over one results worker. A second call used to start another results worker that replaced the first, and `close()` never closed the first one, so it kept consuming after shutdown. Two engines sharing a transport don't settle a result twice: the engine claims the step's pending checkpoint.
  - A `redis://` / `rediss://` connection string works. BullMQ copied a bare string onto its defaults character by character and connected to `127.0.0.1:6379` instead. This affected `BullMQTransport` and `runRedisWorker` / `startRun` (which `DurableModule`'s `connection` option feeds). The URL's host, port, credentials, db and TLS are read; query parameters are refused. New `redisUrlToOptions` / `normalizeRedisConnection` exports in `@dudousxd/durable-worker`.
  - New `BullMQTransport.deferConsumers()` / `startConsumers()` and a `deferConsumers` option. They park every point-to-point consumer (tasks, results, decisions, step events, start-run, run-request), and the worker-liveness advertisement, until started.
  - New `DurableModule` option `consumers: false` for producer-only processes (CLI commands, REPLs, scripts). It defers the transports' consumers before the engine subscribes and starts no co-located or thin worker consumer. The default is unchanged.

## 0.48.0

### Minor Changes

- [#378](https://github.com/DavideCarvalho/nestjs-durable/pull/378) [`f4a6674`](https://github.com/DavideCarvalho/nestjs-durable/commit/f4a667449cd12ee7d82da2bf31c592fa8505c9d7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - onError and allSettled follow-ups:

  - Retrying a run whose failure was handed off runs its body again; the previous handoff is retired (renamed `onError:retried:<id>`), and a new failure goes to a new handler run. Handler runs are now `<runId>.onError.<attempt>`, and handoff checkpoints sit at seq 1,000,000,000 and up, past anything a body reaches.
  - `FatalError(message, code?, details?)`: `details` (JSON-serializable) travels on the `StepError` to the run's error, an onError handler's input, and, with `code`, through a child's completion to the parent: `allSettled` rejected items carry `code`/`details`, and a failed `ctx.child` throws a `FatalError` with them. The Python SDK takes `FatalError(..., details=...)` and adds `ctx.all_settled`.
  - A handed-off run is tagged `onError:<code>`, and the engine emits `run.routed`, or `run.unrouted` when the workers announce different routes. Announced routes are read once per 5s.
  - `engine.unservedOnErrorRoutes()`, and a boot warning from the Nest module, for routes whose handler nothing can run.

- [#381](https://github.com/DavideCarvalho/nestjs-durable/pull/381) [`b1e3440`](https://github.com/DavideCarvalho/nestjs-durable/commit/b1e34400fb3f2f9e6c51d3a6309efb99f84bcd1a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A summarized run detail and a fan page no longer read the run's whole checkpoint list.

  - `StateStore` has two new optional methods. `checkpointStats(runId, { group? })` is one `GROUP BY parallel_group, status, <name kind>` that returns counts, seq and timestamp bounds and an attempt sum per bucket. `queryCheckpoints(runId, { group, excludeGroups, statuses, namePrefixes, offset, limit })` pages checkpoints in seq order. Every bundled store implements both, and `CodecStateStore` forwards them.
  - Core's `summarizeRunFromStore` and `pageFanFromStore` build the same `RunDetail` and `FanPage` that `summarizeTimeline` and `pageFan` build from a full read. They read the aggregates, the rows outside wide fans, the folded `fan:` checkpoints, up to 20 failures per fan and the first child edges. While a wide child fan is in flight they also read its completed `signal:child:` rows, because only the payload tells whether a child failed.
  - `StoreRunGateway` uses them when the store has both methods. Otherwise it falls back to the full read. On a 40,000-member step fan, a detail poll now reads 21 rows instead of 40,001, and a page of 100 reads 100.
  - The summarized detail and the fan page carry an `etag`, derived from the run row and the checkpoint buckets. `RunDetailOptions.ifNoneMatch` and `FanPageQuery.ifNoneMatch` let the gateway answer `notModified` after reading only the run and the buckets. The options travel through `ProxyRunGateway` unchanged, so a tenant's poll costs the operator the same.
  - Each store adds a `durable_step_checkpoints_group_idx` index on `(run_id, parallel_group, seq)`.
  - The shared `runStateStoreContract` now expects both methods. It checks them against their in-memory references, and checks that the detail and the pages built on them match the ones built from a full read. The fixture covers step fans, child fans, folded checkpoints, failFast, partial waves and narrow fans.

- [#374](https://github.com/DavideCarvalho/nestjs-durable/pull/374) [`b4ba4c1`](https://github.com/DavideCarvalho/nestjs-durable/commit/b4ba4c1fe3805bbd31ffda81209f36b6c8db8e34) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `onError` routes: when a run ends `failed` with an error whose `code` matches, the engine starts a handler workflow (`<runId>.onError`, input `{ runId, workflow, input, error }`) instead of failing the run, and the run settles with the handler's outcome. The run only follows its handler from then on; its body never runs again. Engine-orchestrated, so it holds for inline, in-app-worker and remote bodies: routes come from the local registration (`@OnError(ErrorClass | code?)` methods, `@Workflow({ onError })`, `register` / `registerRemote({ onError })`) or, for a workflow served by convention, from the `onError` its live workers announce on `WorkflowRegistration` (new golden fixture `descriptor-on-error.json`; the Python SDK announces it via `@worker.workflow(..., on_error=[...])`). `NonDeterminismError` now carries `code: 'non_determinism'`, which is never routed.

### Patch Changes

- [#373](https://github.com/DavideCarvalho/nestjs-durable/pull/373) [`4a9aa48`](https://github.com/DavideCarvalho/nestjs-durable/commit/4a9aa48a7a87c1ab263045ee6464547bd152f010) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.allSettled(workflow | step, inputs, { concurrency })`: the same fan as `ctx.all` in `waitAll` mode, resolving with one `{ status: 'fulfilled', value } | { status: 'rejected', id, error }` per input, in input order, instead of throwing a `GatherError`. A `FatalError` thrown in a dispatched step is no longer retried: it carries `retryable: false`, which the step result builders already honour.

- [#380](https://github.com/DavideCarvalho/nestjs-durable/pull/380) [`b8f4a87`](https://github.com/DavideCarvalho/nestjs-durable/commit/b8f4a87006aed507a52bb8e5ac92d6869adb0737) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Run detail keeps working while a tenant pod and the control plane are on different releases. A tenant's `ProxyRunGateway` talking to a control plane from before summarized details (0.46.x) now summarizes the full detail itself, and pages a fan out of the full detail when the control plane does not know `getFanMembers`. It reads the old responder from its reply, with no timeout wait, and remembers it for a minute (the new optional fourth constructor argument, `capabilityTtlMs`). The `RunRequestResponder` answers a request kind it does not know with an `unsupported-request` error before touching the store. When its gateway throws, it replies with the error instead of leaving the tenant to time out. Old tenants get the same answers as before.

- [#383](https://github.com/DavideCarvalho/nestjs-durable/pull/383) [`cf54b7a`](https://github.com/DavideCarvalho/nestjs-durable/commit/cf54b7ad7a8eafc33020117ceb2b1ec7e1b37333) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - onError polish:
  - Metrics count `run.routed` / `run.unrouted` (`runs.routed`, `runs.unrouted`, `routedByCode`, Prometheus `durable_runs_routed_total{code}`); the OTel bridge adds `durable.run.routed` / `durable.run.unrouted` span events; Telescope tags them `routed` / `unrouted` and `onError:<code>`, with the `reason`.
  - The console shows a failure's `code` and `details` on the failed step and run.
  - The boot warning for an unserved onError route rechecks after 30s, so handlers whose workers start later are not reported.
  - A retry drops the run's `onError:<code>` tag along with the retired handoff.
  - `listCheckpointsByNamePrefix` and `listSignalWaiters` match a prefix literally on every SQL store: `_` / `%` were read as `LIKE` wildcards (and Prisma's `startsWith` on SQLite). New conformance case.
  - Python: `ctx.gather_calls_settled`.

## 0.47.1

### Patch Changes

- [#377](https://github.com/DavideCarvalho/nestjs-durable/pull/377) [`b02f7ad`](https://github.com/DavideCarvalho/nestjs-durable/commit/b02f7adb7bd1ac85c8d9c030f6e3c738de10dbe9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `DurableModule.forRoot` / `forRootAsync` now forward `timerBatchSize`, `reconcileMs`, `eventBufferTtlMs`, `blockedPollMs` and `trackStepStart` to the `WorkflowEngine`. Before, those options could only be set on a hand-built engine, so module users always got the defaults (for example a timer batch of 500).

## 0.47.0

### Minor Changes

- [#371](https://github.com/DavideCarvalho/nestjs-durable/pull/371) [`c994829`](https://github.com/DavideCarvalho/nestjs-durable/commit/c994829354c64b5196fe4934ab7feef3971044c0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The console handles runs with wide fans. For a 40,000-member fan, a run's detail was a 19MB payload, re-fetched every 1.5s and on every live event. An in-flight child fan also fetched one detail per child, twice, and the view rendered a row, a graph node and a header chip per member.

  - **Summarized detail.** `RunGateway.getRunDetail(runId, { summarizeFansOver })` returns each fan wider than that as one `FanSummary` instead of its members:
    - the summary carries the label, size, counts per status (a failed child counts as failed, a folded checkpoint as the children it stands for), the time span and the first 20 failures;
    - `children` is capped at 200, with `childCount` carrying the real total;
    - the option is unset by default, so existing callers keep the full timeline.
  - **Fan pages.** The new optional `RunGateway.getFanMembers(runId, group, { offset, limit, failedOnly })` pages a fan's members. The store gateway implements both, the tenant proxy and responder carry them, and core exports `summarizeTimeline`, `summarizeFan`, `pageFan` and `childIdsOf`.
  - **Dashboard server.** `GET runs/:id` summarizes fans wider than 50 by default (`?full=true` for everything), and `GET runs/:id/fans/:group` pages one fan's members.
  - **Dashboard client.**
    - A summarized fan is one node in the timeline and the graph: `label ×size`, a progress bar per status, and the failures.
    - Expanding a fan loads its members page by page into a virtualized list, with a failed-only filter.
    - No child detail is fetched for a summarized fan, and other child fetches are capped at 50.
    - The header lists 12 child chips plus `+N more`.
    - Live events refetch at most every 1.5s, and the graph layout is memoized.
  - **A fan's declared size.** A child fan's `parallelGroup` now carries its size (`all:<seq>:n<size>[:failFast]`, still read in its old form), as a step fan's already did. `FanSummary` adds `total`, `notStarted` and `failFast`, and a fan declared wider than the threshold is summarized even when only a few of its members have started. The console shows `started of total`:
    - while the run is live, the members not sent yet (waves under `concurrency`) are **not started**;
    - once it has finished, members still running are **interrupted** and the rest **never ran**, marked `(failFast)` when that is why.

## 0.46.3

### Patch Changes

- [#367](https://github.com/DavideCarvalho/nestjs-durable/pull/367) [`c38e83c`](https://github.com/DavideCarvalho/nestjs-durable/commit/c38e83cd9d8261aac254b654bd47a762b7ea9592) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.all` over a `@Step`: `ctx.all(this.lines.processLine, lines, { concurrency })` runs one durable step per input instead of one child workflow per input, and returns the outputs in input order. A child costs a whole run (row, turn, lease, parent signal); a step costs a checkpoint and a dispatch.

  - The steps share a `parallelGroup` (`steps:<firstSeq>:<size>`), so the dashboard renders them as one fan.
  - The engine adds a join barrier for steps: a result resumes the workflow only when no step of the fan is still `pending`, or when one fails. The workflow replays once per settled wave instead of once per result. `Promise.all` over `ctx.step` replays on every result, which makes a fan of N steps cost O(N²) checkpoint reads.
  - `concurrency` sends the steps in waves of that size; `mode: 'failFast'` throws on the first failed step; `waitAll` (the default) throws a `GatherError` with the failed indexes once every step has settled. Every step uses the `@Step`'s retry policy, or the per-call `retries`/`backoff`. A flow-control `queue` and a liveness `timeoutMs` are rejected.
  - A fan's new steps are written `pending` before any is dispatched, so a turn running concurrently with the dispatching one never sends them twice. After the dispatching turn releases its lease, it re-checks the fan, which covers a last result that another instance settled while that turn held the lease.
  - New optional `StateStore.countCheckpoints(runId, fromSeq, toSeq, statuses)`, which the barrier calls on every result. MikroORM and the in-memory store implement it, `CodecStateStore` forwards it, and the shared store contract covers it. A store without it falls back to loading the run's checkpoints.

## 0.46.2

### Patch Changes

- [#359](https://github.com/DavideCarvalho/nestjs-durable/pull/359) [`3102694`](https://github.com/DavideCarvalho/nestjs-durable/commit/3102694eaff63cf6c40f69822810d62472f28a15) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drain budget edge cases. `WorkflowEngine.beginDrain(spentMs)` now ignores non-finite or negative values instead of turning later drains into a ~1 ms wait. A `drain()` already waiting re-reads the reported wait, so a late `beginDrain(spentMs)` shortens it (deadline is its start plus the timeout minus the reported wait). The docs and the retention poller's comment now state that the retention sweep's shutdown wait is bounded by `shutdownTimeoutMs` on its own and is not deducted from the drain.

## 0.46.1

### Patch Changes

- [#356](https://github.com/DavideCarvalho/nestjs-durable/pull/356) [`dbe222d`](https://github.com/DavideCarvalho/nestjs-durable/commit/dbe222de4ac8be195ac9bfd7049e4af3169abaa0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Shutdown now waits for the in-flight timer/retention poll. `TimerPoller` and `RetentionPoller` await their current sweep in `onModuleDestroy`, bounded by `shutdownTimeoutMs` (default 10s) and logging when the bound wins. On a driving operator the timer poller also calls `beginDrain`, so from module destroy the engine starts no new runs in process (they stay pending for the next poll or boot); a non-driving operator is unchanged and still runs work started during shutdown. The wait the poller actually spent is deducted from the registrar's `engine.drain()`, so poll wait plus drain stay within one `shutdownTimeoutMs`; time passing between the two (other hooks, HTTP close) is not charged. Core adds `WorkflowEngine.beginDrain(spentMs?)` and an optional `ScheduleHost.isDraining()`; `resumeLeased`, `recoverIncomplete`, `sweepTimeouts` and `schedules.tick` stop starting work once draining, and `resumeLeased` releases a lease taken as drain began. nestjs calls `beginDrain` optionally, so it still works against an older core.

## 0.46.0

### Minor Changes

- [#355](https://github.com/DavideCarvalho/nestjs-durable/pull/355) [`b54cb40`](https://github.com/DavideCarvalho/nestjs-durable/commit/b54cb40247c37fbdc5fd673b95efd949e7192899) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.all` now costs O(N) for a fan of N children. Before, it cost O(N²). It also sends wide fans in batches, can cap how many children run at once, and folds a settled fan into one checkpoint.

  Previously every settled child woke the parent. The parent then replayed the whole fan, re-registering a waiter (`putSignalWaiter`) and looking up the run (`getRun`) for every child still out. N children meant N replays of N items each. In a local benchmark, 100 children took 9s and about 31k DB calls, and a fan of 1,000 children had finished only 36 of them after 15 minutes. In the in-memory store, a fan of 200 children went from 200 parent replays, 19,900 `putSignalWaiter` calls and 20,700 `getRun` calls to 1 replay, 0 `putSignalWaiter` calls and 402 `getRun` calls.

  - **Join barrier.** A settling child no longer wakes the parent while siblings in the same fan still have waiters. The last child to settle wakes it. A failed child of a `failFast` fan still wakes it immediately.
  - **Batched dispatch.** The fan is registered 500 children at a time through the new `StateStore.registerChildWaits`, which writes the waiters and the `running` placeholders in one transaction. Its existing checkpoints are read with one prefix query instead of one lookup per child, and the redundant per-child `getRun` is gone (`start` is already idempotent by id). Sending a 1,200-child fan now takes 3 store writes and 1 read from the parent.
  - **`concurrency` option.** `ctx.all(wf, inputs, { concurrency: 1000 })` keeps at most 1,000 children running. They go out in waves of `floor(concurrency / 2)`, two waves at a time (an odd limit runs one child under it), and the parent sends the next wave as soon as one settles. Wave children carry the wave in their id (`<runId>.all.<firstSeq>.w<k>.<i>`). A limit at or above the fan size keeps the unbounded ids.
  - **Folding settled fans.** Once a fan of 100+ children (or one wave of it) settles with every child successful, its per-child checkpoints are replaced, atomically, by one `fan:<child id base>` checkpoint holding the outputs in order, through the new `StateStore.compactCheckpoints`. Every later turn of the parent then loads one row for the fan instead of one per child: after a 1,000-child fan, the next turn reads 2 checkpoints instead of 1,001. Replay expands the folded checkpoint back in memory, `getRunChildren`, cancel and purge still see every child, and runs written before the upgrade replay unchanged. A group with a failed child stays unfolded so `requeue` can retry it, and a fan under 100 children keeps per-child checkpoints for the dashboard.
  - **Reads scoped to a run, not every waiter.** A wide fan leaves one live waiter per running child, and several reads used to scan the whole waiter table: `getRunChildren` (run detail, cancel cascade), the purge subtree walk, `findParentRunId`, every `listRuns`/`waitingFor` page of the run gateway, and every `resumeDueTimers` tick. They now read only the runs they need through the new `StateStore.listSignalWaitersByRun`, served by the `runId` index below.
  - **Dashboard.** A folded group renders as its child-run count (`150 child runs`), and a fan of folded waves is labelled `child runs ×N`, instead of the raw `fan:` checkpoint name.
  - **Telescope.** The Backlog gauge and the Runs-by-state donut count through `countRuns` instead of loading up to 10,000 full runs per status and reporting `runs.length`, which capped at 10,000 and read every row. Entries for a child run started by `ctx.all`, `ctx.child` or `ctx.startChild` are tagged `parent:<runId>` and carry `parentRunId`, so every child of a fan is one filter away from the parent. `parentRunIdOf(runId)` is exported from core.
  - **No waiter re-registration on replay.** A child's running placeholder is only written with or after its waiter, so neither `ctx.all` nor `ctx.child` re-puts it on replay. That re-put was wasted work, and it could leave a waiter behind for a child that had already settled. `requeue` (the dashboard retry) now puts the waiter itself when it turns a failed child back into a `running` placeholder. If a successful `~retry~` of that child is already buffered, `requeue` settles the checkpoint with it directly instead of waiting on a waiter nothing would fill.
  - **Lost-wake re-drive.** A wake that finds the parent's lease held is dropped. If a `ctx.all` fan or wave, or a `ctx.child`, settled during such a turn, the parent re-drives itself once the turn releases the lease, instead of waiting for the `reconcileMs` sweep.

  New optional `StateStore` methods, implemented by every bundled store and covered by the shared contract suite: `hasSignalWaiter(runId, tokenPrefix)`, `listSignalWaitersByRun(runIds)`, `registerChildWaits(entries)` and `compactCheckpoints(runId, fromSeq, toSeq, into)`. A custom store without them keeps working: without `hasSignalWaiter` the parent replays once per settled child, without `listSignalWaitersByRun` those reads scan every waiter as before, without `registerChildWaits` the waiters and placeholders are written one by one, and without `compactCheckpoints` settled fans are not folded.

  New index `durable_signal_waiters_run_id_idx` on `durable_signal_waiters (run_id)`, which the barrier's per-child lookup and the run-scoped waiter reads use. MikroORM and TypeORM auto-schema (and their `ensure*` helpers) create it. With Prisma, run `prisma migrate`. With Drizzle on SQLite, run `drizzle-kit generate` + `migrate`; Drizzle on Postgres already had it. If you own the schema by hand:

  ```sql
  CREATE INDEX durable_signal_waiters_run_id_idx ON durable_signal_waiters (run_id); -- the column your naming maps `runId` to
  ```

  A `failFast` fan's `parallelGroup` is now `all:<seq>:failFast` (it was `all:<seq>`), which is how the barrier knows to wake on the first failure. A `failFast` run already suspended before the upgrade is treated as `waitAll` by the barrier: it still throws its `GatherError`, but only once the whole fan has settled.

## 0.45.1

### Patch Changes

- [#344](https://github.com/DavideCarvalho/nestjs-durable/pull/344) [`717fa46`](https://github.com/DavideCarvalho/nestjs-durable/commit/717fa46fdd07993d117ca36047c70e0e45371ef4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Prevent handled workflow turn failures from creating an unhandled tracking rejection. Reject and clean up waitForRun when its store lookup fails, and contain background tenant-event lookup and initial Redis liveness failures so temporary storage errors do not terminate the worker.

## 0.45.0

### Minor Changes

- [#337](https://github.com/DavideCarvalho/nestjs-durable/pull/337) [`099da78`](https://github.com/DavideCarvalho/nestjs-durable/commit/099da78b831bd85e1778a58bd0eb817d99a7a9c9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New `DynamicWorkflowCtx<A>` type: `WorkflowCtx` with ONE string-addressed signature for each of its
  overloaded methods (`step`, `child`, `startChild`, `all`). Every `WorkflowCtx<A>` is assignable to it,
  so code that drives the ctx by names (a graph interpreter) and test fakes can depend on it — or on a
  `Pick` of it — instead of re-declaring a narrow interface and reaching for `ctx as unknown as …`.
  A type-test guards that `WorkflowCtx` stays assignable to it and to a hand-written interpreter-style
  interface. Re-exported from `@dudousxd/nestjs-durable`.

- [#338](https://github.com/DavideCarvalho/nestjs-durable/pull/338) [`98072c9`](https://github.com/DavideCarvalho/nestjs-durable/commit/98072c92b4c836d50e36c6df493b9cb0fd7e63f3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Persisted schedules** — Temporal-style schedules managed at runtime and stored next to the runs,
  instead of only the code-registered `schedules` option.

  - `engine.schedules`: `create` / `upsert` / `get` / `list` / `pause(note?)` / `resume` / `trigger` /
    `delete` / `tick`. A schedule starts `workflow` with `input` on a `cron` (+ IANA `timezone`) or a
    fixed `every` interval, with a stable per-window `jitter`, an `overlap` policy (`allow` / `skip`
    while the previous run is in flight), a `catchup` policy (`latest` missed window once, or `skip`),
    `tags` (also stamped on its runs, plus `schedule:<id>`), `searchAttributes`, `priority` and a
    `namespace`. Failed starts are recorded as `lastError`; `get`/`list` report next/last fire, last run
    and fire count.
  - **Multi-worker safe without locks**: a window's run id is deterministic (`sched:<id>:<windowMs>`, so
    racing starts collapse) and advancing a schedule is a compare-and-set on its `next_fire_at`.
  - `DurableModule.forRoot({ persistedSchedules: true })` fires due schedules on every timer-poll tick
    (off by default — a deployment that never uses them doesn't need the new table).
  - New `durable_schedules` table and five optional `StateStore` methods (`saveSchedule`, `getSchedule`,
    `updateSchedule` with CAS, `deleteSchedule`, `listSchedules`), implemented by every bundled store:
    in-memory, Drizzle SQLite + Postgres (pgTable + DDL), TypeORM and MikroORM (auto-schema), Prisma
    (`DurableSchedule` model to copy). `CodecStateStore` forwards them and encodes the schedule input.
    Drizzle SQLite users run `drizzle-kit generate`; Prisma users add the model — only if they use it.
  - Dashboard: a header **schedules** chip listing cadence / next / last / error with pause, resume and
    run-now; API `GET /schedules`, `POST /schedules/:id/{pause,resume,trigger}`.
  - Core exports `nextCronFireMs` (the forward counterpart of `prevCronFireMs`).

- [#335](https://github.com/DavideCarvalho/nestjs-durable/pull/335) [`a9d8571`](https://github.com/DavideCarvalho/nestjs-durable/commit/a9d8571fe1231be955a1632c5b675fea37ea228d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Retention can be **scoped**, and a tenant's runs can be **purged** through the engine — no more
  reaching into the `durable_*` tables to do either.

  - **`RetentionPolicy.scope`** confines a policy to the runs matching a `RunScope` — `namespace(s)`,
    `workflow(s)`, `tag`/`tags`, search-attribute `attributes`. A scoped policy only selects, and for
    `maxCount` only counts, runs in its scope ("keep acme's newest 100"). Boot validation now requires
    status sets to be disjoint _per scope_, so a scoped policy can sit next to an unscoped default.
  - **`engine.purgeRuns(scope, opts?)` / `engine.purgeNamespace(ns)`** hard-delete every run matching a
    scope, with their child subtrees (children inherit `namespace`, not `tags` — they go with their root
    either way), in bounded batches. Live runs are cancelled first (`cancelLive: false` keeps them). An
    empty scope is rejected.
  - **`StateStore.deleteRuns(ids)`** (optional): bulk cascading delete, one `IN (...)` per table. The
    engine falls back to per-run `deleteRun` on a store without it.
  - **`pruneTerminalRuns` everywhere.** The in-memory, Drizzle (SQLite), TypeORM and Prisma adapters now
    implement it (MikroORM and Drizzle Postgres already did, and now honor `scope`), so `retention` works
    on every bundled store. `CodecStateStore` now forwards `pruneTerminalRuns` and `deleteRuns` —
    retention used to be silently disabled behind the codec wrapper.
  - The shared StateStore contract covers `deleteRuns`, age/count/scoped pruning and `engine.purgeRuns`.

- [#336](https://github.com/DavideCarvalho/nestjs-durable/pull/336) [`1b7824b`](https://github.com/DavideCarvalho/nestjs-durable/commit/1b7824bbe26dbf503861cadd4388d5dfc9be217e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Start-time concurrency quotas.** Cap how many runs sharing a key can be in flight, and reject the
  start that would exceed it — "a tenant can have at most 8 turns executing" without a hand-rolled
  `SELECT count(*)` gate.

  - `@Workflow({ concurrency: { key: (input) => …, limit, countStatuses? } })` (also on
    `engine.register` / `registerRemote` / `remote`), or per start with
    `StartOptions.concurrency: { key, limit, countStatuses? }` (overrides the workflow's). The key is
    global, so several workflows can share one quota; `limit` may be an async function of the key
    (per-plan limits); `countStatuses` narrows what occupies a slot (default: every non-terminal
    status — e.g. use `['pending', 'running']` so runs parked on a human don't count).
  - Over the limit, `start` throws **`ConcurrencyLimitError`** (`key`, `limit`, `active`, `workflow`) and
    creates nothing. Quota-bearing runs carry the engine-minted tag `concurrency:<key>`.
  - New optional **`StateStore.countRuns(query)`** — one `COUNT(*)` over the `listRuns` predicates —
    implemented by every bundled store and forwarded by `CodecStateStore`; the engine falls back to
    `runFacets`, then to a listing, for a custom store without it. Covered by the shared contract.

  It is a soft cap under a race (count and insert are separate statements); use `singleton` for a strict,
  queueing per-key limit.

## 0.44.0

### Minor Changes

- [#327](https://github.com/DavideCarvalho/nestjs-durable/pull/327) [`f877666`](https://github.com/DavideCarvalho/nestjs-durable/commit/f877666d875ee62f088716a477b47f8f1854658d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Re-drive a `gather_calls` step whose worker was killed mid-step, instead of orphaning it forever.

  A polyglot workflow's turn declares its fan-out as `call` commands; `applyCommands` writes a
  `pending` checkpoint and dispatches each one. On every later turn the worker's replay RE-EMITS
  the calls it is still waiting on, and the engine skips a command whose checkpoint already
  exists — the guard that stops a partially-settled fan-out from double-dispatching its live
  siblings.

  That guard had no notion of a LOST job. A worker OOM-killed mid-step takes its in-flight job
  with it, and for a non-TS consumer nothing bridges the job's terminal failure back into a
  `StepResult` (the TypeScript transport has always done this; the Python SDK did not, which is
  why a Python fleet's steps orphan where a Node fleet's do not — fixed on that side too, in
  `durable-worker`). The checkpoint therefore stayed `pending` — "out for delivery" — and every
  turn skipped it: the run woke on the `reconcileMs` sweep, dispatched a turn, had the calls
  re-emitted, skipped them, and slept. Forever. Observed on a six-run fan-out: `pending`,
  `attempts = 1`, checkpoint `wakeAt` NULL, over an hour, no retry, while sibling steps
  dispatched in the same batch completed normally on the restarted worker.

  The two tells name the gap exactly. `callRemote` (the `ctx.step` path) stamps a re-dispatch
  deadline on the pending checkpoint's `wakeAt` and honours `remoteRedispatchMs`; the `call` path
  did neither — so the documented lost-dispatch self-heal **did not exist for a fan-out**, no
  matter how it was configured.

  Now the two paths share one policy, and a pending remote checkpoint's `wakeAt` means the same
  thing in both: the step's LEASE.

  - A settled checkpoint always wins — a step that completed just before the crash is never re-run.
  - `remoteRedispatchMs` unset (still the default) keeps the by-design "re-suspend, never
    re-dispatch": a merely-slow worker is never double-run.
  - Set it and the dispatched step carries a lease, and the run suspends ON it (never later than
    the `reconcileMs` sweep would have woken it anyway). Only a LAPSED lease re-dispatches,
    bounded by `remoteRedispatchMax` (default 10); past the bound the step is failed
    `remote_step_lost`, which enters the run's history so the workflow's own error path surfaces
    it rather than the engine looping.
  - A step-scoped heartbeat now RENEWS that lease durably (`{ runId, seq, stepId, group }` on the
    heartbeat channel), so a worker still holding a long step keeps it — the in-memory rearm only
    ever protected a `timeoutMs` step, and only on the instance that dispatched it.
  - Observability: a re-drive emits `step.started` with `redispatched: true` and appends a `warn`
    `step.redispatched` event to the checkpoint's own trail (`step.lost` at the bound), so
    "re-driven after a lost worker" reads differently from a failure retry — in the dashboard and
    in the database.

  `DurableModule` also **forwards `remoteRedispatchMs` / `remoteRedispatchMax`** for the first
  time. They were engine-only options the Nest module never passed on, so every consumer wiring
  the engine through `DurableModule` was stuck with the orphan-forever default regardless of what
  it set.

## 0.43.2

### Patch Changes

- 8be6504: Optional peers are actually optional — the package loads without `@dudousxd/durable-worker`

  `@dudousxd/nestjs-durable` declares `@dudousxd/durable-worker` optional, then statically imported it
  from three modules that the package entry re-exports. Anyone who took the declaration at its word —
  an operator that owns the store and runs no worker at all — got `ERR_MODULE_NOT_FOUND` out of
  `dist/index.js` before a line of their own code ran. Both the ESM and the CJS entry were affected.

  **Every value from the worker SDK is now reached lazily**, through a single module, on the path that
  needs it: `startRun` at the tenant client's `start`, `runRedisWorker` at bootstrap, and the
  `DurableWorkerRuntime` in the provider factory that stands the runtime up — and that factory is
  gated on the role, so an operator never reaches the import. A worker role configured without the
  peer installed now fails with a message that names the package instead of a resolution error.

  The runtime a pure thin worker registers on moved from the `DurableWorkerRuntime` class to a
  `DURABLE_WORKER_RUNTIME` symbol token, because a class from an optional peer cannot be a DI token
  without dragging the peer into the static import graph. It is exported; `moduleRef.get(...)` against
  the class must become `moduleRef.get(DURABLE_WORKER_RUNTIME)`.

  **`@Workflow({ inputSchema })` works in the ESM build.** `class-validator` and `class-transformer`
  were loaded with `require()`, which esbuild leaves as a shim that throws in a real ESM process — so
  the peers looked missing even when installed, and every ESM app registering an `inputSchema`
  workflow died at boot telling you to install what it already had. They are loaded with `import()`
  now, inside the validator.

  `optional-peers.spec.ts` holds the line: it builds the package, installs the artifact into a temp
  tree with each optional peer withheld in turn, and boots a real app against it.

## 0.43.1

### Patch Changes

- 7885b5a: Stop a single unrecoverable run from crash-looping every worker.

  `TimerPoller.poll()` and `RetentionPoller.sweep()` are awaited inside
  `onApplicationBootstrap` and fired as `void` on an interval, so a rejection out of
  either one was fatal twice over — it propagated through `NestApplication.init()` into
  the host's `bootstrap()`, and on the interval it surfaced as an unhandled rejection.
  Because the state that caused it survived the restart, one bad row in the run store
  took the pod down on every boot, stopping every other workflow in the deployment with
  it. Both sweeps now absorb and report their failures, per sub-sweep, so a poll that
  goes wrong costs that tick and nothing more.

  `WorkflowEngine.resumeLeased` no longer lets one run end the batch either. A leased
  batch is a mixed bag during a rolling deploy — skew protection makes `resume` throw for
  the workflows a pod does not have — and aborting there meant a single run stopped
  recovery for every run behind it. Such a run is now skipped and left for an instance
  that can drive it, which is what the skew-protection error asks for.

## 0.43.0

### Minor Changes

- 1171860: Multi-value run predicates, and the distinct values behind them

  `RunQuery` could only ever ask for ONE tag, ONE tenant, ONE origin. An operator comparing two
  tenants, or looking at two kinds of run, had to issue two queries and read two lists.

  ```ts
  store.listRuns({ tags: ["etl", "nightly"], namespaces: ["acme", "globex"] });
  store.listRuns({ origins: ["@acme/billing", null] }); // …plus the runs nothing claims
  store.listRuns({
    attributes: [{ key: "tier", op: "in", values: ["pro", "enterprise"] }],
  });
  ```

  `workflows`, `statuses`, `tags`, `namespaces` and `origins` each OR within themselves and AND with
  everything else; an empty set matches nothing, mirroring the `statuses` field that already worked
  this way. `origins` carries `null` as a member, which is the one thing the single `origin` cannot
  express: "this package plus the runs nothing could attribute".

  `AttributeFilter` gains an `in` op, carrying a `values` SET. It needs to be its own operator because
  two `eq` predicates on the same key are ANDed like every other pair, and no run has one attribute
  with two values — so without it, a multi-select over attribute values always returns nothing.

  **`StateStore.runValueFacets`** (optional, like `runFacets`) answers the other half: the distinct
  values of one filter axis over the runs matching a query, with counts. It is what lets a console
  offer a picker instead of a text box — every offered value returns runs, and the counts say how
  many. The run-table axes are an exact `GROUP BY`; `tag` and the search-attribute axes live outside
  the row (a JSON array, a side table) and are counted over a bounded scan of recent matching runs,
  which `RunValueFacetOptions.scan` documents and bounds.

  `RunGateway` gains the same method, so it works on a tenant deployment (no store, proxying over the
  transport) as well as on the control plane.

## 0.42.1

### Patch Changes

- 4559f11: Add NestJS 12 to the supported peer range

  NestJS 12 ships its core packages as pure ESM and requires Node >= 20.19. These packages are already
  `"type": "module"`, so nothing in the source had to change — but their `@nestjs/*` peer ranges topped
  out at `^11`, which is enough for a host app on 12 to get an unmet-peer warning or, on a strict
  installer, a refused install.

  `@nestjs/common` and `@nestjs/core` now accept `^10.0.0 || ^11.0.0 || ^12.0.0`, and
  `@nestjs/event-emitter` — whose own line jumped straight from 3.x to 12.x to track the framework —
  accepts `^2.0.0 || ^3.0.0 || ^12.0.0`. The dev dependencies moved to the 12.x line as well, so the
  suite that guards the module wiring, the lifecycle hooks and the in-app worker now runs against
  NestJS 12 rather than only claiming to support it.

## 0.42.0

### Minor Changes

- 89f9377: The console stays responsive on a control plane with tens of thousands of runs

  Measured against a live deployment holding 9,533 runs, the console was unusable: `GET /runs` returned
  **12.24 MB** (uncompressed) every 3 seconds, the run list mounted **115,636 DOM nodes**, and the tab
  spent **26.9 of every 30 seconds** with its main thread blocked — a 16-second freeze on open, then
  ~4 seconds on every poll. Opening a long run (488 checkpoints) blocked it for another 21 seconds.
  The same measurements now read **0.24 s** and **0 ms of steady-state freeze**.

  What changed:

  - **The run list is a page.** `GET runs` accepts `limit`/`offset` (every store already implemented
    them; the console simply never sent them) and the SPA fetches 100 rows, virtualised so only the
    visible ones are mounted, with "show more" to go further back.
  - **New `runs/facets` endpoint**, backed by `StateStore.runFacets` / `RunGateway.runFacets` — one
    `GROUP BY status, origin` aggregate. This is what makes paging safe: the page bounds what is
    rendered, the status and origin chips still report the whole matching set.
  - **`RunQuery.origin` accepts `null`** to select runs carrying no origin (`origin IS NULL`). The
    console's "unknown" facet used to be applied in the browser precisely because an exact-match filter
    cannot express absence, which meant it needed every run in memory to work. It is now a server-side
    predicate, on the list and on bulk actions alike.
  - **The list endpoint returns rows, not runs.** `input`, `output` and `error` are omitted — on the
    deployment measured, `error` alone (a stack trace per failed run) was 63% of the payload, and no
    list row reads any of the three. `GET runs/:id` is unchanged.
  - **`GET runs` accepts a repeated `status` param** (`?status=running&status=suspended`), ORed into
    `RunQuery.statuses`. A single value still narrows to that status exactly as before.
  - **The detail pane no longer re-lays-out a run on every poll.** It, the workflow graph and the span
    timeline are memoised, the graph culls off-screen nodes, and the run detail's own sibling lookup
    went from listing every run every 3 seconds to a bounded query issued only for singleton runs.
  - **The "no live worker" banner reads worker health** rather than the runs on screen, so it cannot go
    quiet just because the stalled runs fell off the page.

  Nothing is required of consumers: absent `limit`/`offset` still returns the whole listing, and
  `runFacets` is optional on `StateStore` (a store without it falls back to counting a listing).
  `RunGateway` implementors must add `runFacets`.

## 0.41.0

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

## 0.40.0

### Minor Changes

- 0203613: Stamp every run with the package that declared its workflow.

  `WorkflowRun` gains `origin?: string` and `RunQuery` gains an `origin` predicate, so a deployment can
  finally answer "which lib produced this run" — the agent framework, a catalog pipeline, the app
  itself. It sits next to `namespace` and is stamped the same way: at creation, from the registration,
  never from `StartOptions`. Nothing a caller passes to `start` can make its run claim another lib's
  name, because origin describes the registered code, not whoever pressed the button.

  It is DERIVED, because the alternative does not work. `@Workflow({ tags })` is the only thing that
  already resembles this and it is voluntary, so it is wrong in the field the moment one lib forgets: a
  facet built on tags lists the two libs that opted in and implies the other three are not running,
  which is worse than shipping no facet. So `@Workflow` captures the file it is being applied in — the
  one moment we are provably executing inside the declaring module — and `WorkflowRegistrar` resolves
  that file to the nearest enclosing `package.json` name at registration. A lib that has never heard of
  this feature is attributed anyway, and there is nothing for it to forget.

  `undefined` means UNKNOWN, never "the app". Runs created before this field existed have none; so do
  registration paths that carry none (`registerRemote`, convention routing, a synthesized remote
  child), and any workflow whose declaring package could not be resolved with confidence — a runtime
  without `Error.captureStackTrace`, a frame that is not a real file, no named `package.json` above it.
  Those are named in a single boot warning rather than given a plausible-looking default, because an
  origin filter that quietly drops runs looks exactly like runs that never happened. A UI facet over
  `RunQuery.origin` has to keep an "all origins" option for the same reason: unattributed runs match no
  origin value at all.

## 0.39.1

### Patch Changes

- 97df572: Re-export `RunGateway` as a value, so it works as the DI token it is

  `RunGateway` is an abstract class that doubles as its own DI token (`RUN_GATEWAY` is the
  deprecated alias pointing at the same class), but the facade block in `index.ts` re-exported it
  from `export type { ... }`. The `.d.ts` rollup drops the `type` modifier, so consumers saw a
  value export and type-checked green, while the JS bundle correctly omitted it:

  ```ts
  import { RunGateway } from "@dudousxd/nestjs-durable"; // undefined at runtime
  moduleRef.get(RunGateway); // Nest could not find given element
  ```

  `tsc`, `tsup` and the test suite were all green — the failure only surfaced on the code path that
  resolved the gateway. `RunGateway` now sits in the value re-export next to `WorkflowEngine`, and a
  new spec asserts every facade-re-exported core class survives into the bundle.

## 0.39.0

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

## 0.38.0

### Minor Changes

- f0ada3f: Make the `RunGateway` DI token idiomatic. `RunGateway` (in `-core`) is now an **abstract class** that doubles as its own NestJS injection token, so providers bind `{ provide: RunGateway, useFactory/useClass }` and consumers inject `constructor(private readonly gateway: RunGateway)` — no string/symbol token. Because `-core` is a required peer of both `nestjs-durable` and its dashboard, the single abstract class is a shared token across packages, replacing the previous duplicated `Symbol.for('nestjs-durable:run-gateway')` value-sharing hack.

  Non-breaking: the `RUN_GATEWAY` symbol export is kept as a `@deprecated` alias pointing at the `RunGateway` class, so existing `@Inject(RUN_GATEWAY)` / `{ provide: RUN_GATEWAY }` sites resolve the very same token. It will be removed in a future major.

## 0.37.0

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

## 0.36.0

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

## 0.35.0

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

### Patch Changes

- 79e1ea6: `TRANSPORT_CANONICAL` now falls back to the pool's primary (`transports[0].transport`) when only
  `transports` (plural) is configured. Previously it resolved strictly from the singular `transport`
  option, so a pool-configured operator (e.g. the tenant-scoped control plane pairing a namespaced
  primary with a bare-prefix secondary) injected `null` into the step registrar and in-app worker —
  NO step handlers were registered on that pod, and its own steps parked in `wait` with no consumer
  (no heartbeats, no errors). Single-`transport` setups are unchanged.

## 0.34.2

### Patch Changes

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

## 0.34.1

### Patch Changes

- d023e95: **Events gain the same lost-wake protection `ad5c510` gave signals.** Before this release,
  `engine.publishEvent` silently DROPPED a publish that matched no live `ctx.waitForEvent` waiter, and
  `waitForEvent` never consulted any buffer — the same class of bug the prior signal-race fix closed,
  just unfixed for events (e.g. a webhook/event source firing before the workflow reached its
  `waitForEvent` call would lose that event forever).

  Semantics (mirrors `signalWithStart`'s reliability contract for signals, documented on
  `engine.publishEvent`):

  - A publish that resumes ≥1 live waiter, or routes into an `eventBatch` accumulator / starts ≥1
    `onEvent` subscriber, behaves exactly as before and is NOT buffered — fan-out stays live-only.
  - A publish that touches NOBODY buffers ONE copy (`opts.buffer: false` opts out), consumed by the
    FIRST future `waitForEvent(name, { match })` whose match accepts it — point-to-point on redelivery,
    by design, even though the live path above is fan-out. `opts.id` dedupe still applies to subscriber
    starts only.
  - Right after buffering, `publishEvent` re-checks for a waiter that registered in the sliver between
    the initial miss and the buffer write (sandwich parity with `signal`'s own take → buffer → recheck);
    `waitForEvent` does the mirror-image check right after registering. UNLIKE `waitForSignal`, an event
    token embeds the call's own `runId#seq` (never reused across iterations the way a signal token can
    be), so there is no entity-loop-reuse hazard from registering before checking — a single
    post-registration scan closes the race.
  - New engine option `eventBufferTtlMs` (default unset = keep until consumed, like buffered signals):
    when set, the due-timer reconcile pass prunes expired buffered events for the names it already
    touches during its sweep.

  New SPI: `StateStore.bufferEvent`/`listBufferedEvents`/`removeBufferedEvent` (a new
  `durable_buffered_events` table, name-keyed with match-based consumption rather than the token-keyed
  blind-take `bufferSignal`/`takeBufferedSignal` uses — the match predicate belongs to the WAITER, so
  consumption is list + evaluate locally + atomically claim), implemented across every first-party store
  (in-memory, MikroORM, Drizzle, Prisma, TypeORM) with a shared conformance case. The remote/polyglot
  workflow-command protocol has no `waitEvent` command — events remain reachable only from in-process
  `ctx.waitForEvent` and `engine.publishEvent`, not from a remote-executor workflow; extending that
  protocol is future work, not invented here.

  **`nestjs-durable-dashboard` gains first-class `guards`/`imports` options** on
  `DurableDashboardModule.forRoot(...)`, mirroring `@dudousxd/nestjs-agent-dashboard`'s console exactly:
  guard classes are stamped onto BOTH the UI (page) controller and the JSON API controller via
  `@nestjs/common`'s own `@UseGuards` metadata key (replace, not append, on a repeated `forRoot` call),
  and `DurableApiModule` is now a dynamic module so a guard's own dependencies resolve from the host's
  `imports` instead of failing to boot with "Nest can't resolve dependencies ... in the DurableApiModule
  context". Documents the header-vs-cookie reality for the two mount points: the JSON API is fetched by
  the SPA's own JS (a header-based guard works normally), but the UI shell is a full-page browser
  navigation with no custom header — only an ambient cookie (or no guard at all) reaches it there.

## 0.34.0

### Minor Changes

- 8cc4733: New `attributesOf(WorkflowClass, run)`: read a run's search attributes **by workflow class**, with the
  schema resolved from that class's `@Workflow({ searchAttributes })` decorator metadata — the same
  by-class idiom as triggering a workflow (`ctx.child(ShippingWorkflow, input)`), so readers reference
  the workflow and never re-import/re-declare its schema. The return type is inferred structurally from
  the class's `run(ctx: WorkflowCtx<A>, …)` annotation — no explicit type argument needed. Delegates to
  core's `readSearchAttributes` for the lenient safe-parse read (invalid/legacy/missing attributes →
  `{}`). Throws a teaching error if the class isn't `@Workflow`-decorated, or declares no
  `searchAttributes` schema to resolve against.

## 0.33.0

### Minor Changes

- f40d7bd: New opt-in `WorkflowHandler<TInput, TOutput, A>` interface: `implements` it on a `@Workflow` class to
  pin `run(ctx, input)`'s signature at the declaration site, so a wrong signature (renamed method,
  swapped/missing param, wrong return type) is a compile error at the class instead of a runtime
  discovery failure or a silently-wrong type flowing out of `ctx.child`/`engine.start`. Types-only —
  registration and engine behavior are unchanged. Also extends `@dudousxd/nestjs-durable`'s core facade
  re-exports with `readSearchAttributes`, `StepEvent`, `InferSearchAttributes`, `SearchAttributesSchema`,
  and `WorkflowHandler`.

## 0.32.0

### Minor Changes

- db17f15: `topology: { role: 'control-plane' }` accepts an optional `tenant`, mapped onto `namespace` — one `tenant` vocabulary for both roles, resolved to the right axis (operator poll-scoping vs worker queue-routing). Undefined = global operator, unchanged.

## 0.31.0

### Minor Changes

- 25f8000: **Breakpoint-aware `RunWaiting` + bulk `RunGateway.waitingFor`.** `ctx.breakpoint()` registers a
  signal waiter under the hood (`bp:<runId>:<seq>`, resumed by `engine.continue`), but `RunWaiting` —
  what the dashboard/an app names a suspended run as being parked on — had no `breakpoint` case, so a
  paused run showed up as waiting on a raw-token `signal` named `bp:r1:7`. `RunWaiting.on` gains a
  `'breakpoint'` variant (`classifyWaiterToken` now recognises the `bp:` prefix); this also fixes how
  `listRuns` labels breakpoint waiters, since it shares the same classifier.

  New `RunGateway.waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>>` — bulk-resolve
  what a set of runs is currently parked on, for a consumer with its own filtered/paginated run listing
  that needs "which of MY runs are stuck at a breakpoint" without re-deriving the waiter scan or
  querying `durable_step_checkpoints` directly. Implemented on `StoreRunGateway` (two bulk store scans,
  never one query per id) and forwarded by `ProxyRunGateway` over the existing run-request/reply
  transport (one request for the whole id list); the operator-side `RunRequestResponder` scopes the
  reply to runs the requesting tenant actually owns.

- 25f8000: Re-export the everyday `@dudousxd/nestjs-durable-core` surface from `@dudousxd/nestjs-durable` — `RunGateway`, `RunDetail`, `RunListItem`, `RunWaiting`, `RunQuery`, `AttributeFilter`, `RunStatus`, `WorkflowRun`, `StepCheckpoint`, `WorkflowCtx`, `SearchAttributes`, `WorkflowEngine`, `EngineEvent`, and `StepLogger` (types re-exported type-only; `WorkflowEngine` as a value). Previously a consumer had to import `RUN_GATEWAY` from `@dudousxd/nestjs-durable` but its `RunGateway` type from `-core`, or the `Workflow` decorator from `@dudousxd/nestjs-durable` but `WorkflowEngine`/`WorkflowCtx` from `-core` — now both live under one import.
- 25f8000: **`DurableModuleOptions.topology` — an explicit, validated deployment-role preset.** Today the
  operator/worker split is only inferred from which of `store`/`connection` are set, and the boundary
  between `namespace` (the operator's poll-scoping axis) and `partition` (the worker's queue-routing
  suffix) is only documented in prose — a real consumer app grew a 250-line module whose comments exist
  solely to reconcile the two. `topology` names the role up front and validates the axes for you:

  ```ts
  // Control plane: owns the store, dispatches over the transport.
  DurableModule.forRoot({
    topology: { role: "control-plane" },
    store,
    transport,
  });

  // Tenant: store-less worker scoped to its own partition — `tenant` maps onto `partition` for you.
  DurableModule.forRoot({
    topology: { role: "tenant", tenant: "acme-corp" },
    connection: process.env.REDIS_URL,
  });
  ```

  - `{ role: 'control-plane' }` requires `store` + (`transport` or `transports`); forbids `partition`
    (a worker axis) and a `tenant` field. `namespace` and `connection` stay allowed.
  - `{ role: 'tenant', tenant }` requires `connection`; forbids `store` (a tenant is store-less by
    definition) and `namespace` (the operator's own axis); maps `tenant` onto `partition` internally —
    an explicit `partition` that disagrees with `tenant` throws, one that matches is a no-op.
  - Every rejection is a multi-line error naming the role, the offending option, and the one-line reason
    — these messages are the point, not just the validation.
  - `topology` is entirely additive: omit it and `store`/`connection` inference is unchanged.

  See [Tenancy & topologies](https://davidecarvalho.github.io/aviary/docs/durable/concepts/tenancy#the-topology-preset).

- 25f8000: Typed, validated search attributes. `@Workflow({ searchAttributes })` takes a **Standard Schema** (https://standardschema.dev — zod 3.24+, valibot, arktype, …) whose inferred output must be search-attribute-shaped (flat `string`/`number`/`boolean` values only — enforced at the declaration site, a nested-object schema is a compile error). When declared, `ctx.upsertSearchAttributes` validates the MERGED result (existing attributes shallow-merged with the patch) before writing — an invalid merge throws, naming the workflow, the offending key(s), and the schema's issues. Validation runs once, at the same first-run-only position as the write itself, so it's skipped on replay like the write. `WorkflowCtx` is now generic (`WorkflowCtx<A extends SearchAttributes = SearchAttributes>`, defaulting to the untyped shape, fully backward compatible) — pair it with the new `InferSearchAttributes<typeof mySchema>` helper to type a workflow's `run(ctx: WorkflowCtx<...>, input)`. Core also exports a new `readSearchAttributes(schema, run)` helper for the read side: safe-parse semantics — an invalid or missing `run.searchAttributes` returns `{}` (typed) instead of throwing, since older runs may predate the schema. No schema declared ⇒ unvalidated behavior is unchanged.

## 0.30.2

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

## 0.30.1

### Patch Changes

- fa75b51: Make a suspended run's WHY legible in the `/durable` dashboard. The engine keeps one generic
  `suspended` for every durably-parked run, so the list used to show one flat badge whether a run was
  waiting on a signal, blocked with no worker, or queued behind a singleton leader. Now:

  - **Waiting on what** — the control plane resolves each suspended run's event wait from its signal
    waiters (one bulk `listSignalWaiters` scan, no per-run timeline fetch) and names it in the list row:
    `signal <name>` / `webhook <token>` / `child <id>` (new `RunWaiting` on the gateway's `RunListItem`,
    classified by waiter-token prefix — `wh:` / `child:` / `event:` — via the new `classifyWaiterToken`).
  - **No worker** — a run whose handler has no live worker is flagged `no-worker` (joined against the
    Workers panel's health), with a header banner listing the stalled workflows, so "control plane up
    but nothing consuming the queue" is obvious at a glance instead of looking like a normal sleep.
  - **Queued behind a singleton** — runs sharing a `singleton:<key>` tag show the leader as running and
    the rest as `queued`, naming the leader — derived entirely client-side (the engine already stamps
    the tag), mirroring the admission order.

  All states re-derive on the existing poll, so they flip to `running` on their own the moment a worker
  rejoins or the leader settles. Deliberately event-only on the server (no timer/step guess): `wakeAt`
  alone can't tell a real `ctx.sleep` from the reconcile-fallback `wakeAt` an event/step suspend now
  carries, so a non-event suspend with a live worker shows as `running` rather than a misleading
  "sleeping" — the detail view (which has the timeline) still distinguishes them precisely.

## 0.30.0

### Minor Changes

- c27c276: The dashboard header now shows the deployment's durable **role** — "control plane" or "tenant · <partition>" — instead of a hardcoded "control plane" label (which was wrong on a tenant). `RunGateway` gains a synchronous `topology(): DurableTopology` (`{ role: 'control-plane' | 'tenant'; tenant? }`): the store-backed gateway reports `control-plane`, the `ProxyRunGateway` reports `tenant` with its partition name. Exposed via `GET /api/durable/topology` and rendered as a header badge (tenant highlighted amber). No round-trip — it's local metadata each gateway already holds.

## 0.29.0

### Minor Changes

- ccd7abc: The dashboard **Workers** panel now works on a tenant deployment. `workerHealth` moves onto the `RunGateway` port (joining the read/control verbs), so a store-less tenant proxies it over the transport instead of hitting the operator-only guard and throwing `This durable dashboard operation requires the control plane`. The `RunRequestResponder` — the tenant boundary — answers it scoped to the requester's own groups by the `<name>@<tenant>` queue convention, so a tenant only ever sees the health of ITS OWN queues, never another tenant's or the operator's bare groups. On the control plane the behaviour is unchanged (every group, unscoped). `metrics`/`getEvent`/`update`/`deliverWebhook` stay control-plane-only.

## 0.28.0

### Minor Changes

- 54dc0af: Class-first workflow API: `@Workflow` classes extending the new `DurableWorkflow` base gain `MyWorkflow.start(input)` (fire-and-forget — `engine.start` outside a workflow, a parent-linked `ctx.startChild` inside one) and `MyWorkflow.execute(input)` (run-and-await the typed output — `ctx.child` inside, start + wait-until-terminal outside), with input/output inferred from the subclass's own `run` signature. Powered by a new ambient workflow context (`AsyncLocalStorage`) the engine and the thin worker install around every body execution (`currentWorkflowCtx()`), per-class engine bindings written by the registrar at boot (`bindWorkflowClass`), and `waitForRun`'s new `until: 'terminal'` option.
- 1de193a: Rename `@OnEvent` to `@OnDurableEvent` — the old name clashes with `@nestjs/event-emitter`'s `@OnEvent`, and in an app using both libraries an auto-import picking the wrong decorator fails silently in either direction. `OnEvent` remains exported as a deprecated alias and will be removed in the next minor.

## 0.27.0

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

- d7447d3: `DurableControlPlaneModule` now actually DRIVES runs instead of orphaning them: a new internal
  `drive?: boolean` option on `DurableModuleOptions` (defaults to `worker !== false` — back-compat)
  gates `TimerPoller`'s and `WorkflowRegistrar`'s boot-time poll/recovery independently of `worker`,
  and the engine's `runDispatcher` no-op is now selected only when `worker === false && drive !== true`.
  `DurableControlPlaneModule.forRoot`/`forRootAsync` set `{ worker: false, drive: true }`: an OPERATOR
  control plane that polls pending, recovers crashed runs, resumes due timers, and sweeps timeouts, but
  never executes a `@Workflow`/`@Step` body itself — pair it with `remoteByConvention: true` so each
  driven run dispatches to a remote tenant worker group instead. A plain `worker: false` (API/dashboard)
  instance is unchanged: drive stays off, the no-op dispatcher stays in place.

  `DurableWorkerModule` accepts a new `tenant?: string` option: each configured group is served under
  `tenantGroup(group, tenant)` (`@dudousxd/nestjs-durable-core`) — `undefined`/`''`/`'default'` stays
  the bare group (production unchanged); any other tenant serves `<group>@<tenant>`, matching the group
  name an operator control plane's `remoteByConvention` routes that tenant's runs to.

  Also corrects `DurableModuleOptions.namespace`'s JSDoc, which still said the default was `'default'`
  — it's unset, and omitting it makes the instance an OPERATOR that drives every namespace (mirrors the
  already-corrected wording on `WorkflowEngineDeps.namespace`).

- 04d6137: Thread the tenant / control-plane options through the NestJS module:

  - `remoteByConvention?: boolean` — forwarded to the engine so an unregistered workflow routes to the
    live worker group of the same name (default `false`).
  - `scopeReads?: boolean` — opt-in tenant read scoping. When `true` and `namespace` is set, the module
    asks the store for a namespace-scoped view via an optional `withScope` capability (the MikroORM
    adapter provides it); a store without it is used as-is. Default `false` — the control plane stays
    unscoped (operator view).
  - `DurableControlPlaneModule` — an intention-revealing alias whose `forRoot`/`forRootAsync` delegate
    to `DurableModule` with `worker: false` forced, for a dispatch/dashboard-only control-plane instance
    fronting tenant workers packaged via `DurableWorkerModule`.

- b4b8b73: Tenant run gateway: a store-less tenant worker can now read (getRunDetail/listRuns), control
  (cancel/retry/continue/retryWithInput), and live-stream its OWN runs over the shared transport, via a
  new `RunGateway` port. The control plane binds a store-backed gateway and answers tenant requests —
  scoped to the tenant's namespace — over a new run-request queue plus run-reply and per-tenant-event
  pub/sub channels; a tenant binds a `ProxyRunGateway` (given an app-supplied transport). No store and no
  HTTP on the tenant side; every request is namespace-scoped so a tenant can never read or act on another
  tenant's run. `EngineEvent` now carries an optional `namespace` (stamped on `run.*` lifecycle events)
  so the control plane can re-publish a run's events to its owning tenant.
- 45c7d75: Topology-agnostic dashboard: `DashboardService` run views/control/stream now route through the `RUN_GATEWAY` port, so a store-less tenant can mount the same `DurableDashboardModule` the operator uses (backed by `ProxyRunGateway`). `RunGateway.cancel` gains an optional `compensate` opts; `DurableWorkerModule` is now `global` so a globally-mounted dashboard resolves `RUN_GATEWAY` on a tenant. Operator-only operations (metrics, worker health, webhook delivery, live event read, update delivery) require the control plane and throw a clear error on a tenant.
- de58581: Uniform durable start for tenant apps. `engine.start(...)` is now identical across topologies: a
  tenant worker (no store) resolves the same `WorkflowEngine` token to a store-less `DurableStartClient`
  that transparently publishes a start-run message to the control plane instead of touching a DB.
  `searchAttributes` now ride the start-run path (`StartRunMessage` → `startRun` → the created run), so a
  tenant start carries the same queryable data a local start does. Store/driver-bound ops on a tenant
  worker (`cancel`/`deleteRun`/`resume`/`waitForRun`/`signal`/`signalWithStart`/`publishEvent`) throw a
  clear tenant error (the operator owns them). No app-facing `start_run` call is introduced.

### Patch Changes

- 0ba0fc9: Fix operator boot crash when wiring the tenant run-gateway responder over a broker transport whose `onRunRequest`/`publishRunReply` are class methods that use private fields (e.g. `BullMQTransport`). `RunGatewayBootstrap` was passing those methods to the `RunRequestResponder` destructured/unbound, so on `onApplicationBootstrap` the responder called them with the wrong receiver and V8 threw "Receiver must be an instance of class …". The methods are now bound to the transport (matching the adjacent `publishTenantEvent.bind`).

## 0.26.0

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

## 0.25.0

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

## 0.24.0

### Minor Changes

- 21d5594: Add `namespace` run partitioning. An engine configured with a `namespace` stamps it on every run it
  creates and only picks up / recovers / resumes-timers-for / times-out runs in that namespace. The
  StateStore list methods (`listPendingRuns`, `listIncompleteRuns`, `listDueTimers`) and `RunQuery`
  gain an optional namespace filter. Default `'default'` — byte-identical to a single-pool deployment.
  Implemented for the MikroORM store; Drizzle/TypeORM/Prisma parity is a follow-up (they ignore the
  filter until then). Read paths (dashboard, `getRun`) are intentionally not namespace-scoped.

## 0.23.0

### Minor Changes

- 3f8595f: Uniform dispatch, Phase 3: an opt-in in-app worker, plus the single-context-contract guarantee that makes it safe. The default is NOT flipped — group-routed dispatch stays strictly opt-in.

  **`@dudousxd/nestjs-durable` — in-app worker (opt-in).** `DurableModule.forRoot({ ..., inAppWorker: { group, connection } })` turns one Nest app into both roles: every discovered `@Workflow` is registered GROUP-SERVED (its turns are dispatched to the app's own `group` over the transport via a `RemoteWorkflowExecutor`, instead of run inline), and a co-located `DurableWorkerRuntime` consumes that group (`runRedisWorker`) and replays the SAME discovered TS bodies; `@DurableStep` handlers register on the same runtime. This is the uniform-dispatch "one app, both roles, own group" shape — every turn pays a broker round-trip even though the worker is the same process. It requires a workflow-task transport (BullMQ) and fails fast otherwise. Strictly additive and isolated: the providers are inert when `inAppWorker` is unset (the binding resolves to `null`, the bootstrap no-ops), so a plain `DurableModule` and the inline fast path are byte-for-byte unchanged. New exports: `DurableInAppWorkerOptions`, `InAppWorkerBootstrap`, and the `IN_APP_*` tokens (incl. `IN_APP_RUN_REDIS_WORKER` for testing without Redis).

  **`@dudousxd/durable-worker` — the one-contract guarantee.** The inline runtime (`createWorkflowCtx`, store-coupled) and the replay runtime (`WorkflowContext`, store-less) are two intentionally distinct implementations of ONE `WorkflowCtx` contract; they must agree wherever the contract is observable or a run checkpointed on one and resumed on the other corrupts. New conformance specs pin that: (a) the full inline `WorkflowCtx` surface exists on `WorkflowContext` — the exact drift that surfaced as the `durable-worker.module.ts:76` typecheck failure when `ctx.upsertSearchAttributes` was added to the contract but a stale build of the replay runtime lacked it (now resolved); and (b) both runtimes allocate identical seqs and record identical `(seq, name, output)` for local steps across a suspend, plus the unbounded-wait one-seq rule. An end-to-end spec proves "engine + worker in one app, own group" through the REAL `RemoteWorkflowExecutor` + `WorkflowWorker` over a transport seam, across complete / suspend-resume / recovery / cancel.

  **Default not flipped (deliberate).** Benchmarked the per-turn cost: an in-process (loopback) hop is within noise of zero, but over a real BullMQ/Redis broker each turn costs ~4–6 ms (local Redis, serialized) and that multiplies by a workflow's turn count and grows on networked/loaded production Redis. Flipping the default would also break every consuming app not configured with a workflow-task transport + in-app worker. So uniform dispatch ships opt-in; flipping the default would additionally require engine-level default-group resolution in `execute()`/`resume()` (the highest-risk, replay-path change) and is left for a future, separately-benchmarked phase.

## 0.22.1

### Patch Changes

- 5d2add9: Ship TanStack Intent agent skills (SKILL.md) inside the package.

## 0.22.0

### Minor Changes

- c4b133f: Retention config now accepts `ms`-style duration strings (and no longer leaks raw millisecond magic numbers).

  `RetentionPolicy.maxAgeMs` → **`maxAge`** and `DurableRetentionOptions.sweepIntervalMs` → **`sweepInterval`**, each now `number | string`: a number is still milliseconds, a string is parsed by the library's existing `parseDuration` (the same parser behind `ctx.sleep` / `executionTimeout`), e.g. `'30d'`, `'2w'`, `'5m'`. Note `'m'` is **minutes** (the `ms` convention) — there is no month unit, so use `'30d'` / `'90d'` for a month / quarter. Unparseable strings throw at boot (fail fast).

  ```ts
  retention: {
    sweepInterval: '5m',
    policies: [
      { statuses: ['completed', 'cancelled'], maxAge: '30d', maxCount: 200 },
      { statuses: ['failed'], maxAge: '90d' },
    ],
  }
  ```

  This refines the retention API shipped in the previous minor (`maxAgeMs` / `sweepIntervalMs`); update those two field names if you adopted it.

## 0.21.0

### Minor Changes

- 00713f8: Add terminal-run retention pruning and the missing MikroORM store indexes, so the timer poller's per-tick scans stay cheap as run history grows.

  **Retention.** New `retention` option on `DurableModule.forRoot`, driven by a worker-only `RetentionPoller` on its own interval (default 60s, separate from the 1s timer poll). Configure one or more policies per (disjoint) terminal-status group, each bounded by `maxAgeMs` and/or `maxCount` — composed most-restrictively (a run is pruned if it violates either bound), ranked by `updatedAt`:

  ```ts
  retention: {
    sweepIntervalMs: 60_000,
    batchSize: 1_000,
    policies: [
      { statuses: ['completed', 'cancelled'], maxAgeMs: 14 * 24 * 3600_000, maxCount: 200 },
      { statuses: ['failed'], maxAgeMs: 90 * 24 * 3600_000 }, // keep failures longer
    ],
  }
  ```

  Backed by a new optional `StateStore.pruneTerminalRuns(policy, nowMs, limit)` capability (implemented by the MikroORM adapter; it cascades to child rows like `deleteRun` and self-drains in batches). Config is validated at boot: statuses must be terminal and disjoint, and each policy must set at least one bound. Core also exports `RetentionPolicy` and `TERMINAL_RUN_STATUSES`. Omitting `retention` keeps all history (unchanged default).

  **Indexes.** The MikroORM store now defines the indexes the Prisma adapter already had — `durable_workflow_runs (status, wakeAt)` and `(workflow, status)`, plus `durable_run_attributes (key, numValue)` / `(key, strValue)` — so the poller's status/timer scans and the search-attribute EXISTS join are index-backed instead of full scans on an ever-growing table. `ensureMikroOrmDurableSchema` now also applies standalone `create index ... on durable_*` statements (the Postgres/SQLite index form), which were previously filtered out.

## 0.20.0

### Minor Changes

- 31b1389: Track A liveness-rearm: a per-run heartbeat that lets a remote workflow `advance` self-heal a dead worker without re-driving a live (slow) one.

  - **core:** new opt-in `WorkflowEngineDeps.remoteAdvanceSilenceMs`. When set, the engine wraps the remote workflow `advance` in a heartbeat-rearmed deadline keyed by `runId`: each run-scoped `Heartbeat` (a beat with no `stepId`) rearms the window, and only a genuinely-silent worker trips `RemoteWorkflowTimeout` → lease released → recovery re-drives. This closes the duplicate-side-effect hazard of a fixed `RemoteWorkflowExecutor` `timeoutMs` (which can fire mid-step on a still-working worker). Default unset = prior unbounded await — no behavior change. `Heartbeat.stepId` is now optional to carry run-scoped beats. Internally, the per-step liveness helper was generalized into a single `awaitWithLivenessDeadline` reused by both the step and workflow paths.
  - **durable-worker:** the Node workflow worker now emits a run-scoped heartbeat on the shared `<prefix>-heartbeat` channel while replaying a turn (immediate + every 5s, cleared on settle), so an engine configured with `remoteAdvanceSilenceMs` keeps a slow-but-alive worker alive instead of re-driving it.

## 0.19.0

### Minor Changes

- 256b8c3: Add a **thin Node/NestJS worker** — a control-plane-less worker (the Node analog of the Python `durable-worker`), so a plain Node/NestJS service can be a pure worker with no store, no engine, no recovery, and no dashboard. The single control-plane engine remains the sole owner of state; N thin workers (Python and now Node) just consume tasks → run handlers / replay workflow bodies → return `StepResult`/`WorkflowDecision` over BullMQ.

  New package `@dudousxd/durable-worker`:

  - `WorkflowContext` — `implements WorkflowCtx`, so a `@Workflow` body written against the engine's authoring API runs unchanged on the thin worker (history → commands replay). Wire-expressible ops (`step`, `call`, `sleep`, `waitForSignal`, `child`, `all`, `now/random/uuid`, plus a `gather` extension) are supported; ops needing engine/store features (`transaction`, `callEntity`, `webhook`, `setEvent`, `onUpdate`, `patched`, `task`, `continueAsNew`, `sleepUntil`, `waitForEvent`, fire-and-forget `startChild`) throw `UnsupportedOnThinWorker`.
  - `WorkflowWorker.processTask` / `StepWorker.processTask` — pure, transport-free decision/result producers.
  - A BullMQ runner that consumes the engine's task queues and returns decisions/results (queue names match `@dudousxd/nestjs-durable-transport-bullmq` exactly).

  `@dudousxd/nestjs-durable` gains `DurableWorkerModule.forRoot({ connection, groups })`: discovers `@Workflow`/`@DurableStep` providers and runs them on the thin worker runtime + BullMQ runner — a NestJS worker process with no `WorkflowEngine`/store bound. A conformance test proves the same `@Workflow` produces identical output and ordered `(seq, name, kind)` on the engine and the thin worker.

## 0.18.1

### Patch Changes

- 1d76da7: Migrate all internal consumers (engine factory, registrars, timer poller, dashboard service, telescope data providers) to the canonical capability tokens, and flip the dual-bind so the canonical token (`@dudousxd/nestjs-durable:state-store`/`:transport`/`:options`) is the real provider while the legacy `nestjs-durable:*` tokens become `useExisting` back-compat aliases. The legacy tokens are now `@deprecated` but still resolve to the same instances — fully non-breaking.

## 0.18.0

### Minor Changes

- def217f: Add canonical, cross-lib-discoverable aliases for the durable DI tokens — `STATE_STORE_CANONICAL`, `TRANSPORT_CANONICAL`, `DURABLE_OPTIONS_CANONICAL` (`@dudousxd/nestjs-durable:state-store` / `:transport` / `:options`, identical to `capability('durable', …)`). `DurableModule` dual-binds them as `useExisting` aliases of the existing tokens, so an external library can resolve durable's store/transport/options by the canonical capability name without importing durable internals. Fully additive and non-breaking: the legacy `nestjs-durable:*` tokens are unchanged and keep working.

## 0.17.0

### Minor Changes

- a9b0b2e: Pluggable admission backend + Redis-backed global flow control.

  The remote-step flow-control gate (`ctx.call(step, input, { queue })`) is now driven by a pluggable
  `AdmissionBackend` instead of an in-process-only controller:

  - **core** — new `AdmissionBackend` interface; the default `InMemoryAdmissionBackend` preserves the
    existing per-instance behaviour. Inject a custom backend via `new WorkflowEngine({ admission })`.
    The admit/release path is async, and an optional `onFreed` capability lets a freed slot wake this
    instance's blocked runs early instead of waiting for their retry tick.
  - **@dudousxd/nestjs-durable-admission-redis** (new) — `RedisAdmissionBackend` makes `concurrency`,
    `rateLimit`, priority **and** `fairness: 'key'` ordering GLOBAL across engine replicas, enforced by
    one atomic Lua script:

    - **Concurrency** via slot→instance ownership: a slot is reclaimed only when its owner's liveness
      heartbeat lapses, so a live pod holds it for the full step duration (no time-lease false purge)
      while a crashed pod's slots free within `instanceTtlMs`.
    - **Rate limit** via a fixed-window counter.
    - **Ordering** by priority desc → fairness round-robin by `key` → arrival order, with abandoned
      waiters pruned so a cancelled run can't deadlock the rest as a phantom best-waiter.

    The arrival tiebreak direction is configurable per queue via `QueueConfig.order: 'fifo' | 'lifo'`
    (default `fifo`) — `lifo` admits the most recent arrival first (a stack). Honored by both the
    in-process and Redis backends; orthogonal to priority and fairness.

    - **Early wake** by publishing a freed-slot signal on `release` that the engine subscribes to.

  - **nestjs** — `DurableModule.forRoot({ admission })` forwards the backend to the engine.

## 0.16.0

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

## 0.15.0

### Minor Changes

- 00d5dcf: Auto-feed the workflow context carrier from `@dudousxd/nestjs-context`. When the optional peer is installed (its accessor bound to the shared `CONTEXT_ACCESSOR` symbol) and the app passes no `context` option, `DurableModule` now defaults the engine's `context` reader to build `{ traceId, tenantId, userRef }` from the request-scoped accessor — so a workflow dispatched within a request automatically carries the originating context across process boundaries. The accessor is resolved structurally (no hard import; `@dudousxd/nestjs-context` is an optional peer dependency). An app-provided `context` option still wins, and with no accessor the carrier stays omitted (unchanged behavior). Exposes the `CONTEXT_ACCESSOR` token and a structural `ContextAccessor` interface.
- 00d5dcf: Re-hydrate the originating context around a LOCAL step body (consume side). The engine gains an optional `rehydrate` hook (`<T>(carrier, fn) => T`) that wraps the in-process local step-handler invocation, passing the run's `context` carrier; the default is a passthrough, so behavior is byte-identical when unset. `DurableModule` wires it automatically when `@dudousxd/nestjs-context` is installed (an accessor is bound): it resolves nestjs-context's module-level `Context` singleton via a guarded dynamic import at module init and runs each local step inside `Context.deserialize(carrier, fn)`, so `Context.userRef()/tenantId()/traceId()` work ambiently inside a `@DurableStep` handler without the consumer wrapping anything. No handler signature change (the context is ambient via AsyncLocalStorage); `@dudousxd/nestjs-context` stays an optional peer (no hard/static import), and re-hydration is best-effort — an empty/undefined carrier just runs the handler normally.

## 0.14.0

### Minor Changes

- e00d037: Optional opaque context carrier dispatched alongside `traceparent`: `WorkflowEngine`/`DurableModule` gain a `context?: () => Record<string, unknown>` option, injected into `RemoteTask` at all dispatch sites and surfaced in the Python SDK (`StepContext.context` / `current_context()`).

## 0.13.0

### Minor Changes

- 56eea68: Close the transport on graceful shutdown, not just drain the engine.

  `WorkflowRegistrar.onApplicationShutdown` drained in-flight runs but left the transport open, so a
  deploy left the broker workers consuming and connections to time out. It now closes the transport(s)
  _after_ the drain (so in-flight runs can still dispatch/await their remote steps while draining). Adds
  an optional `close?()` to the `Transport` interface — a no-op for in-process transports; the BullMQ
  transport already implemented it. Remember this only fires if the app calls `app.enableShutdownHooks()`.

## 0.12.0

### Minor Changes

- 64bfcbe: Durable keyed **entities** (virtual objects) — a per-key actor whose handlers run **serialized over durable state**, exactly once. Generalizes singleton; ideal for counters, carts, rate-limiters, aggregators.

  - **Core**: `engine.registerEntity(name, { initialState, handlers })`; `engine.signalEntity(name, key, op, arg)` (fire) / `engine.getEntityState(name, key)` (read); from a workflow, `ctx.callEntity(name, key, op, arg)` (call + await result) and `ctx.signalEntity(...)`. Each key is one long-lived run processing ops in order.
  - **NestJS**: `@Entity({ name })` on an `@Injectable()` class with `@On(op)` methods over its fields (state); `EntityService.signal/getState`. A fresh instance per key is the initial state; methods are re-attached after replay.

  (Per-key history compaction via continueAsNew for very-hot keys is a follow-up.)

- 8ba981d: Signal-with-start (durable entities), cancel→child propagation, and low-latency dispatch.

  - **Reliable signals + `signalWithStart`**: a signal sent with no waiter is now **buffered** (FIFO per token) and delivered to the next `waitForSignal` — signals are never lost to timing. `engine.signalWithStart(workflow, input, runId, { token, payload })` / `workflowService.signalWithStart(...)` ensures a run exists then delivers a signal, race-free — the canonical **durable-entity / accumulator** pattern (one long-lived run per key fed events by many calls). New `StateStore.bufferSignal` / `takeBufferedSignal` (custom stores must add them; all bundled adapters do).
  - **Cancellation cascades to children**: `engine.cancel(parent)` now cancels the runs it started via `ctx.child` / `ctx.startChild` (recursively), and no longer clobbers an already-finished run.
  - **Low-latency cross-pod dispatch**: a run enqueued on one instance (e.g. an API pod) nudges worker instances over the control plane (`engine.onEnqueued`) to pick it up at once instead of on the next poll. The dashboard `/metrics` adds `durable_pending_runs` (dispatch backlog) + `durable_dead_runs` (DLQ size) gauges.

- fb9746a: Event **debounce** and **batch** for `onEvent` triggers — coalesce a burst of events into fewer runs (Inngest-style).

  - `@Workflow({ onEvent: ['x'], debounce: '30s' })` — start one run with the LAST payload once events have been quiet for the window (resets on each event).
  - `@Workflow({ onEvent: ['x'], batch: { maxSize: 100, within: '10s' } })` — start one run with all payloads (`{ events: [...] }`) once `maxSize` is reached or `within` elapses from the first event.
  - Engine: `register(..., { eventBatch })`. Built on the new signal buffering + `signalWithStart` + `continueAsNew` — a per-target accumulator coalesces and then starts the target.

  (Queue priority from the same roadmap item is deferred: the poll-based flow-control queue model makes strict priority awkward, and soft priority adds little.)

## 0.11.0

### Minor Changes

- c99508d: Self-healing recovery + non-blocking dashboard actions.

  - **Lease renewal**: while a run executes, the engine renews its recovery lease (every `leaseMs/2`), so a live worker keeps a long run while a **crashed** worker's lease still expires. `execute` now holds the lease for the whole run on every entry path (sweep, signal, remote result, dashboard), so a run is never double-executed. New `StateStore.renewRunLock(runId, owner, leaseUntilMs)` — **custom stores must add it**.
  - **Periodic orphan recovery**: the NestJS `TimerPoller` now calls `engine.recoverIncomplete()` each tick, so a run orphaned by a crashed worker self-heals within ~`leaseMs` instead of only on the next boot.
  - **Non-blocking control actions** (fixes the `/durable` retry/cancel request hanging): `retry` now re-enqueues via the new `engine.requeue(runId)` (sets `pending` + dispatches) and `cancel({ compensate })` runs the undo in the background — neither replays the workflow inline in the HTTP request anymore. A worker does the work.

## 0.10.0

### Minor Changes

- a5fd901: **Breaking (0.x minor): `start` now dispatches to a worker instead of running the workflow inline.**

  Previously `engine.start` / `WorkflowService.start` executed the workflow body inline and returned the terminal `RunResult`. Now `start` only **enqueues**: it creates the run as a new `'pending'` status, hands it to a `RunDispatcher`, and returns `{ runId, status: 'pending' }` immediately — the body runs on a worker, so the caller (e.g. an HTTP handler) never blocks on workflow logic.

  **Migration**

  - To await the outcome, use the new `engine.waitForRun(runId)` / `workflowService.waitForRun(runId)` — resolves once the run settles (terminal or suspended). `const { runId } = await start(...); const result = await waitForRun(runId)`.
  - **Default behavior is unchanged for single-process apps**: the default in-process dispatcher executes the run on the same instance (asynchronously), so runs still execute with no extra setup.
  - **Offload to workers**: pass a no-op `runDispatcher` on API/dashboard instances (or set NestJS `worker: false`) so they enqueue-only; worker instances poll `engine.runPending()` (the NestJS `TimerPoller` now does this each tick) to pick up `pending` runs. A broker-backed dispatcher can enqueue to a queue whose workers call `engine.runOne(runId)`.

  New: `RunStatus` gains `'pending'`; engine gains `runOne`, `runPending`, `waitForRun`; `WorkflowEngineDeps.runDispatcher`. The testing harness gains `createTestEngine().run(...)` (start + wait) and the dashboard shows the `pending` state. `StateStore` gains `listPendingRuns(limit)` (oldest-first / FIFO) — **custom store implementations must add it** (all bundled adapters do).

- a5fd901: Event-triggered workflows: a workflow can now **start** on a published event, not just wait for one.

  - **Core**: `engine.register(name, version, fn, { onEvent: ['user.registered'] })` — `publishEvent(name, payload, { id })` now starts a fresh run of every subscribed workflow (payload becomes the input) in addition to resuming `waitForEvent` waiters. Idempotent by `evt:<id>:<workflow>`; the return count includes both resumed and started runs.
  - **NestJS**: `@Workflow({ onEvent: [...] })` **or** a dedicated `@OnEvent('a', 'b')` class decorator (listen to several events; both forms merge). `workflowService.publishEvent(name, payload, { id })` gained the dedup id.

- a5fd901: Input validation at workflow start. The engine now rejects a bad payload **before any run is created**, so invalid input never produces a dead/failed run.

  - **Core** (validator-agnostic): `engine.register(name, version, fn, { validateInput })` — a `(input) => void | Promise<void>` that throws to reject.
  - **NestJS** (class-validator, the controller default): `@Workflow({ inputSchema: CheckoutInput })` validates with the same `plainToInstance` + `validate` NestJS runs in controllers. `class-validator` + `class-transformer` are lazy-required optional peers. For zod/yup/etc. pass `@Workflow({ validateInput })` instead (it wins over `inputSchema`).

- a5fd901: Typed search attributes — query runs by structured data, not just exact-match tag labels.

  - **Start**: `start(wf, input, id, { searchAttributes: { amount: 200, tier: 'pro' } })` stamps typed, queryable data on a run.
  - **Query**: `RunQuery.attributes` takes `{ key, op, value }` predicates ANDed together, with `eq/ne/gt/gte/lt/lte` — so range queries like `amount >= 200 AND tier = 'pro'` work. Applied in-process after the coarse workflow/status/tag filters, so it's portable across all store adapters (typeorm/prisma/mikro-orm/drizzle gain a `searchAttributes` JSON column).
  - **Dashboard**: an attribute filter box (`amount:gte:200, tier:eq:pro`), attribute pills on the run detail, and bulk retry/cancel honoring the same predicates. API: `GET /runs?attr=key:op:value` (repeatable).

- a5fd901: Step interceptors — onion middleware around the real execution of every local `ctx.step` (timing, logging, tracing, error enrichment, context propagation). They fire **only when a step actually executes, never on replay**, so timing/metrics reflect true work.

  - **Core**: `engine.use((invocation, next) => ...)` — `invocation` carries `{ runId, workflow, stepName, seq, attempt }`; `next()` runs the step body / next interceptor and returns its result. First registered is outermost. Returns an unsubscribe.
  - **NestJS**: `@StepInterceptor()` on an `@Injectable()` class implementing `DurableStepInterceptor` (so it can inject loggers/tracers). Discovered and wired on boot.

## 0.9.0

### Minor Changes

- f2260da: feat: named events — ctx.waitForEvent + engine.publishEvent

  Name-based pub/sub on top of the signal machinery, for choreography beyond point-to-point signals. A
  run suspends on `ctx.waitForEvent('payment.settled', { match: { orderId }, timeoutMs })` and resumes
  with the payload; `engine.publishEvent(name, payload)` (also `WorkflowService.publishEvent`) fans out
  to every waiting run whose `match` the payload satisfies, returning how many it resumed. The match is
  encoded in the waiter token, so the only store change is a new `listSignalWaiters(prefix)` method
  (implemented across in-memory, TypeORM, MikroORM, Prisma, Drizzle) — no new schema.

## 0.8.0

### Minor Changes

- c3398be: feat: executionTimeout — cap a run's wall-clock lifetime

  `@Workflow({ executionTimeout: '2h' })` (or ms) moves a run to `cancelled` (`execution_timeout`) once
  it outlives the budget — a backstop for runs that get stuck or loop forever. Enforced by a new
  `engine.sweepTimeouts(now)` the timer poller calls each tick (over the existing workflow+status query;
  no new schema). The terminal `cancelled` state means a late step result can't resurrect it.

## 0.7.0

### Minor Changes

- bc4539d: feat: singleton — serialize runs by key (durable FIFO mutex)

  `@Workflow({ singleton: { key: (input) => `base:${input.baseId}` } })` runs at most one run per key
  at a time (e.g. one pipeline per base). Same-key runs queue — suspended, admitted in creation order
  as slots free — instead of running concurrently. `limit` (default 1) raises the concurrency. Race-free
  and FIFO on a consistent store: admission is the same `(createdAt, id)` view for every engine instance,
  implemented over the existing tag+status query (no new schema). Also exposed as
  `engine.register(name, version, fn, { singleton })`.

## 0.6.0

### Minor Changes

- 685258f: feat: workflow tags + search

  Label runs and search/filter by them in the dashboard. Tags come from two sources, merged onto each
  run:

  - **Static** — `@Workflow({ name: 'pipeline', tags: ['etl', 'critical'] })` stamps every run of the
    workflow.
  - **Per-run** — `WorkflowService.start(wf, input, runId, { tags: ['nightly'] })` (and
    `engine.start(..., { tags })`) adds run-scoped tags.

  `WorkflowRun.tags` is stored across all store adapters (in-memory, TypeORM, MikroORM, Prisma,
  Drizzle), and `RunQuery.tag` filters by an exact tag. The dashboard shows tags on each run (list +
  detail) and adds a tag filter box; clicking a tag filters the list. The dashboard API gains a
  `?tag=` query param.

## 0.5.0

### Minor Changes

- 2addfd2: feat: per-workflow dead-letter handlers (`@DeadLetter()` + `@Workflow({ deadLetterWorkflow })`)

  Dead-lettering is now per-workflow, not just a single global module option. A dead run's handler is
  resolved in this order:

  1. an inline **`@DeadLetter()`** method on the workflow class — co-located, shares the class's
     injected deps, runs as a durable workflow auto-registered as `<name>.dlq`, and receives a typed
     `DeadLetter<TInput>` payload;
  2. the workflow's **`@Workflow({ deadLetterWorkflow: 'other-wf' })`** reference to another registered
     workflow;
  3. the module-level **`deadLetterWorkflow`** default (unchanged), now a fallback for workflows that
     declare neither.

  A workflow declaring both an inline `@DeadLetter()` and a `deadLetterWorkflow` reference fails fast at
  boot (ambiguous config). DLQ routing now lives in the `WorkflowRegistrar` (which owns the `@Workflow`
  metadata) instead of the module factory. New public exports: the `DeadLetter()` decorator and the
  `DeadLetter<TInput>` payload type.

- 2addfd2: feat: pass workflow **classes** instead of name strings, and a fire-and-forget `ctx.startChild`

  **Workflow class refs.** Anywhere you named a workflow by string, you can now pass its class for a
  same-runtime call — refactor-safe and typed — while strings stay for cross-runtime (e.g. a Python
  workflow):

  - `ctx.child(ShippingWorkflow, input)` — input is type-checked and the result is inferred from the
    child's `run` (no manual type parameter).
  - `engine.start(CheckoutWorkflow, input)` / `WorkflowService.start(CheckoutWorkflow, input)`.
  - `@Workflow({ deadLetterWorkflow: PipelineDlqWorkflow })` and the module-level `deadLetterWorkflow`.

  The `@Workflow` decorator stamps the registered name on the class; `workflowName(ref)` (exported)
  resolves a `WorkflowRef` (`string | WorkflowClass`) back to its name. New exported types:
  `WorkflowClass`, `WorkflowRef`, `WorkflowInputOf`, `WorkflowOutputOf`, and `WORKFLOW_NAME_KEY`.

  **`ctx.startChild`.** A fire-and-forget counterpart to `ctx.child`: dispatches a child once
  (checkpointed, replay-safe) and returns its run id immediately instead of suspending — for side work
  the parent doesn't wait on, or scatter-gather (start many, then `ctx.child` each by the same id to
  join; the start is idempotent by id, so each child runs exactly once).

## 0.4.0

### Minor Changes

- e9799ca: feat: dead-letter handler — `engine.onDead` + `deadLetterWorkflow`

  Dead-lettering is no longer only "park the run in `dead`". `engine.onDead((run) => …)` fires when a
  run is moved to `dead` (exceeded `maxRecoveryAttempts`), so a DLQ handler can alert, push to a real
  queue, or compensate. The NestJS module adds a `deadLetterWorkflow` option that routes a dead run to
  a designated workflow with `{ deadRunId, workflow, input, error }` (idempotent by a `dlq:<runId>` id).
  Omitting both keeps the prior behaviour (the run stays parked, inspectable + retriable).

## 0.3.0

### Minor Changes

- df6524f: feat: cron + timezone schedules

  `ScheduledWorkflow` now accepts a `cron` expression with an IANA `timezone` (DST-aware) as an
  alternative to the fixed-interval `everyMs`. The run id is keyed on the most recent fire time, so
  polling repeatedly within an interval — or racing instances on the same tick — starts each fire
  exactly once (idempotent). The NestJS module gains a `schedules` option; the timer poller fires them
  each tick on **worker** instances only. Cron evaluation uses the optional `cron-parser` peer
  dependency, so the core stays dependency-free for users who don't schedule by cron.

- 3f79533: feat: dead-letter queue — `maxRecoveryAttempts` + `dead` run status

  Crash recovery now counts attempts per run (`WorkflowRun.recoveryAttempts`); once a still-`running`
  run exceeds the engine/module `maxRecoveryAttempts`, it's moved to the new terminal **`dead`** status
  instead of being retried forever — so a poison pill that crashes the process every boot becomes an
  inspectable dead-letter entry, not a crash loop. The new column is persisted by all four store
  adapters (TypeORM auto-schema self-heals it; Prisma/Drizzle/MikroORM schemas updated), and `dead` is
  added to the dashboard/codegen status unions. Omit `maxRecoveryAttempts` for the prior unlimited-retry behaviour.

- 9c4a3cf: feat: durable webhooks (`ctx.webhook()`)

  A first-class, replay-safe "expose a callback URL and wait for it" primitive. `ctx.webhook()` mints
  a deterministic token (`wh:<runId>:<seq>`) and — when the engine has a `webhookUrl` builder — a
  public `url` to hand a third party inside a step; `await handle.wait()` then suspends with zero
  compute until the callback arrives. The dashboard exposes `POST webhooks/:token` (turning the inbound
  POST into `engine.signal`), the NestJS module gains a `webhookUrl` option, and the codegen extension
  emits the `deliverWebhook` (and the previously-missing `continue`) route into the typed client.

- fc9764c: feat: flow control — durable queues for remote steps

  `engine.registerQueue({ name, concurrency, rateLimit })` (or the NestJS module's `queues` option)
  caps how much work `ctx.call(step, input, { queue })` admits at once — a concurrency limit and/or a
  fixed-window rate limit. A call that can't be admitted does **not** dispatch: the run re-suspends
  with the queue's retry time and the timer poller re-tries admission later, so the limit is durable
  (survives crashes) without holding the run in memory. Accounting is per engine instance (the DBOS
  `workerConcurrency` tier); global cross-instance limits remain a follow-up needing a durable counter.

- 7c50198: feat: multiple transports with failover + per-step selection

  The engine now accepts an ordered `transports` pool (`[{ id, transport }]`): it dispatches on the
  first and **fails over to the next on a dispatch error**, and a step can pin one with
  `ctx.call(step, input, { transport: 'sqs' })`. The chosen transport id is stamped on the
  `RemoteTask` (`task.transport`) so a worker that consumes several transports replies on the matching
  one — failover stays symmetric without the worker ever choosing a transport. Results/heartbeats are
  consumed from every transport in the pool. `transport` (single) remains as shorthand for a one-entry
  pool; the NestJS module exposes `transports`. Cross-language note: run one worker/runner per broker
  and the matching one handles each failover hop and replies on its own broker — no worker change
  needed; `task.transport` is there for processes that multiplex brokers.

- 9e36ac0: feat: saga compensation retry + visibility, and a dashboard query index

  - **Compensation retry + visibility** — each saga undo is now retried up to `compensationRetries`
    (engine/module option, default 1) and emits a `compensate:<step>` step event for its outcome, so a
    stranded undo shows up in the dashboard/telescope instead of being silently swallowed. A
    permanently-failing compensation is still skipped so it can't mask the original failure.
  - **TypeORM auto-schema index** — adds `(workflow, status)` alongside the existing `(status, wakeAt)`
    index, so the dashboard's `listRuns` filter hits an index.

- 6836ace: refactor!: separate the control plane from the Transport

  `publishControl`/`onControl` are no longer part of `Transport`; they form a dedicated `ControlPlane`
  interface, and the engine takes a separate `controlPlane` dependency. This decouples cross-instance
  broadcast (lifecycle events + cancellation) from the point-to-point task transport, so you can run a
  dedicated control plane (e.g. Redis pub/sub) independent of how steps are dispatched. Broadcast-capable
  transports (event-emitter, BullMQ) implement `ControlPlane` too and can be passed as both; the NestJS
  module auto-wires the transport as the control plane when it qualifies, or accepts an explicit
  `controlPlane` option.

- 6b36ffa: feat: propagate W3C traceparent to workers (distributed tracing)

  The engine now stamps a `traceparent` on every dispatched `RemoteTask` from an optional
  `traceparent` provider, so a worker (including the Python SDK) can continue the distributed trace
  instead of starting a detached one. Core stays OTel-free: the otel package exports `otelTraceparent()`
  (reads the active span via the registered W3C propagator) to wire in —
  `new WorkflowEngine({ traceparent: () => otelTraceparent() })` — and the NestJS module exposes a
  `traceparent` option. The wire field already existed; this populates it.

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
