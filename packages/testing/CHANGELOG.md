# @dudousxd/nestjs-durable-testing

## 0.23.3

### Patch Changes

- [#430](https://github.com/DavideCarvalho/nestjs-durable/pull/430) [`73ded3f`](https://github.com/DavideCarvalho/nestjs-durable/commit/73ded3fff4c52154ea3e9741b62677b84460c96c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A step fan's join barrier asks whether any step is still pending instead of counting them. Every batch
  of results asked for a `COUNT(*)` over the fan's whole seq range, about 41 ms on a 40,000-step fan in
  MySQL, from every pod settling results. Stores get an optional `hasCheckpoints` that reads from the top
  of the range down and stops at the first match (a fan's highest seqs settle last): 0.9 ms on the same
  fan. Every bundled store implements it; a store without it is asked `countCheckpoints` as before.

## 0.23.2

### Patch Changes

- [#429](https://github.com/DavideCarvalho/nestjs-durable/pull/429) [`1d63676`](https://github.com/DavideCarvalho/nestjs-durable/commit/1d63676605b497a0274d7b583ad489ec0a9fbcbf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The Prisma store settles a batch of step results with one raw statement per 500 rows on Postgres
  and SQLite (`UPDATE … FROM (VALUES …) RETURNING`), and with a locking read plus one `UPDATE … JOIN`
  on MySQL, instead of one `updateMany` per result. A 256-result batch on Postgres takes 10 ms whether
  the steps' inputs are 10 B or 100 KB. A client without raw queries, or on another provider, keeps the
  per-result `updateMany`. The store contract checks that `settleCheckpointsIfPending` sends a fixed
  number of statements for a wide batch.

- [#429](https://github.com/DavideCarvalho/nestjs-durable/pull/429) [`56c5f14`](https://github.com/DavideCarvalho/nestjs-durable/commit/56c5f14f11969048a57c96233c03e7e8bd67997e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A turn no longer reads the input of every step its run completed. The replay snapshot is read
  through the new optional `StateStore.listCheckpointsForReplay`, which returns `listCheckpoints`'
  rows without the input of a completed step, left out of the query itself; a pending or failed step
  keeps it, for its re-dispatch or retry. Every bundled store implements it and `CodecStateStore`
  decodes what it returns; a custom store without it gets `listCheckpoints`. The check a turn makes
  after suspending on a step, whether that step already settled, is now a `COUNT` where the store has
  `countCheckpoints`, so it no longer reads the step's input either. In a conversation of 100 KB-input
  steps, a resume at turn 20 read about 2.1 MB of checkpoints and now reads about 0.1 MB, whatever the
  turn. The run detail, `engine.listCheckpoints`, retry and re-dispatch still read every input.

- [#429](https://github.com/DavideCarvalho/nestjs-durable/pull/429) [`03c7b01`](https://github.com/DavideCarvalho/nestjs-durable/commit/03c7b012351fbab76eadb0fad7a28c936b11927d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A step result's settle no longer reads the step's input. It reads the step's row through the new
  optional `StateStore.getCheckpointsForSettle`, which returns `getCheckpoints`' rows without their
  input, left out of the query itself; the engine uses it only when the store also settles
  column-wise. Every bundled store implements it and `CodecStateStore` decodes what it returns. A step
  with a 100 KB input read about 100 KB back when its result landed; it now reads a few hundred bytes.

- [#429](https://github.com/DavideCarvalho/nestjs-durable/pull/429) [`0fee814`](https://github.com/DavideCarvalho/nestjs-durable/commit/0fee814f16b888f6a18ada1d7988d7989fddd187) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A step's result settles its checkpoint without writing the step's input again. Through the new
  optional `StateStore.settleCheckpointsIfPending`, the engine writes only what a result changes
  (status, output, error, events and the two timings), with the same claim as
  `saveCheckpointsIfPending`: a duplicate delivery still loses. Every bundled store implements it, and
  `CodecStateStore` encodes what it writes. A step with a 100 KB input wrote about 100 KB of checkpoint
  per result; it now writes a few hundred bytes. A custom store without the method keeps the
  whole-row write. The store contract checks the new method, and checks that it sends none of the
  step's input when the factory returns a `statementLog`.

## 0.23.1

### Patch Changes

- [#428](https://github.com/DavideCarvalho/nestjs-durable/pull/428) [`a8a059c`](https://github.com/DavideCarvalho/nestjs-durable/commit/a8a059c76ca9d61fc5f2e622e637df9a3d991f06) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A worker boots while its first timer poll is still running, and the buffered-signal sweep costs a few queries per page instead of one per row.

  - **Boot no longer waits for the first poll.** `TimerPoller.onApplicationBootstrap` (and `RetentionPoller`'s) started the first poll and awaited it. Nest runs every `onApplicationBootstrap` before the HTTP server listens, so a first poll held up by a backlog kept the pod from passing its readiness probe and the rollout failed. The first poll is now started in the background. Shutdown still waits for the poll in flight, bounded by `shutdownTimeoutMs`.
  - **`engine.sweepBufferedSignals()` decides a page set-based.** For each buffered `child:` row it used to read the parent's checkpoints with a `LIKE` on the checkpoint name, and nothing indexes `(run_id, name)`. On a 40,000-child parent that meant one scan of 40,000 rows per buffered row. Now it reads every parent's run row in one batch: a gone or finished parent condemns its rows with no checkpoint read at all. For each parent that is still open, it reads the checkpoints the child ids point to by `(run_id, seq)` on the primary key, one call per parent per page. A `ctx.all` child `<p>.all.<first>.<i>` settles at seq `first + i`, and its fan's fold is at `first` (for a fan in waves, at `first + k * W`, where `W` is the length of wave 0's fold). A read by name is left only for ids that name no seq (an onError handler, a `ctx.startChild` child whose signal is not at its spawn seq, a fan in waves whose wave 0 did not fold).
  - **The sweep has a time budget.** One call stops starting pages or parent reads after 250 ms of wall-clock time and resumes from there on the next tick. It still never runs concurrently with itself.
  - **The child-completion check on the write path reads by key.** `childCompletionNeedsBuffer` runs on every completion of a wide fan that finds no waiter. It now does `getRun` plus one `getCheckpoints` for the child's seq and the fold's, instead of a `LIKE` over the parent's checkpoints.
  - The shared store contract checks that one sweep of 500 buffered rows of a 4,000-checkpoint parent sends at most 10 statements. It sends 6 on SQLite, Postgres and MySQL; it was 504 before.
  - An opt-in MySQL harness (`packages/store-mikro-orm/src/buffered-sweep.harness.db.spec.ts`, `DURABLE_HARNESS=1 pnpm test:db …`) reproduces the shape that broke a rollout: a 40k-child parent, 20k of its children's completions buffered, 42k buffered rows, ~380k checkpoints and ~167k runs. It measures one sweep tick and the write-path check.

## 0.23.0

### Minor Changes

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

## 0.22.3

### Patch Changes

- [#424](https://github.com/DavideCarvalho/nestjs-durable/pull/424) [`2bc6b22`](https://github.com/DavideCarvalho/nestjs-durable/commit/2bc6b223691d96e7a01ec4bb822b422c191cf612) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Child completions no longer pile up in `durable_buffered_signals`. A run that finished with no parent waiter buffered its completion on `child:<runId>` unconditionally, unless its parent held a byte-identical `signal:child:` checkpoint. So every root run (a controller start, a schedule) left a row behind, and so did a child of a settled `ctx.all` fan of 100+ children (folded into one `fan:` checkpoint) or one whose parent's copy came back from a MySQL `json`/Postgres `jsonb` column with its keys reordered. Nothing ever read those rows.

  The engine now buffers a child's completion only when its parent can still consume it: the parent exists, is not completed or cancelled, and does not already hold the outcome (compared ignoring key order, and counting a folded fan). A new `engine.sweepBufferedSignals()`, called by the NestJS timer poller, deletes the `child:` rows that fail that test, including ones earlier versions left: a few pages of 500 per tick until a pass ends, then every ten minutes; skipped on a namespaced engine. Stores gain `listBufferedSignals` (paged by id, by token prefix) and `deleteBufferedSignals`, covered by the StateStore contract. No schema change.

  A parent that joins a child which already finished settles it at once: `ctx.child` (a caller-chosen id, or a spawn joined later) in the same turn from the child's run row, a fan's children with a placeholder from an earlier turn likewise (with `failFast` honoured), and any child whose deferred start (in-process or a remote `startChild` command) finds it already finished gets its completion re-delivered to the waiter it now has. Before, such a parent waited for the reconcile wake, or forever with reconcile off.

## 0.22.2

### Patch Changes

- [#422](https://github.com/DavideCarvalho/nestjs-durable/pull/422) [`58fc295`](https://github.com/DavideCarvalho/nestjs-durable/commit/58fc2958e45794a8c5a7b193888cdb7d77b85370) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - MySQL timestamps keep their milliseconds. The MikroORM and TypeORM stores created every timestamp column as a bare `datetime`, which holds whole seconds and rounds the milliseconds away: lease expiry, `wakeAt` and buffered-event order moved by up to half a second, so a timer could fire early and an engine could reclaim a lease it took just after booting as if a previous process held it. Columns are now `datetime(6)` (Postgres `timestamptz` was already microsecond, and is unchanged).

  An existing MySQL deployment is upgraded by the boot-time schema heal. MySQL runs that type change as a table copy that blocks writes, so on an existing table with more than `blockingAlterRowLimit` rows (default 100000; `schemaBlockingAlterRowLimit` on the store) the statement is logged for you to run out of band instead of run at boot, and the warning repeats each boot until the column matches.

  The BullMQ transport now rewrites every routing token's descriptor copy when a later `handle()` adds a step. A reader keeps whichever copy its SCAN meets first, so a stale copy left the new step's heartbeat undeclared, and the workflow directory listed that step's queue as a callable workflow until the next heartbeat interval.

  The StateStore contract fails instead of passing silently when its backend is unavailable and `DURABLE_TEST_REQUIRE_BACKENDS` is set.

  The run-dispatch contract's "leaves a run whose queueing failed pending" case waits for both re-queued runs to complete, since a consumer may take them in either order. Its "splits a fan's children across the instances" case holds each child until both instances have started one, so the split no longer depends on which in-process consumer the scheduler favours.

  The MikroORM store changes all of a table's timestamp columns in one `ALTER` (its schema diff emits one per column, and MySQL copies the table for each), and both stores log a deferred change as one copy-pasteable statement per table, one per line.

## 0.22.1

### Patch Changes

- [#417](https://github.com/DavideCarvalho/nestjs-durable/pull/417) [`27354f0`](https://github.com/DavideCarvalho/nestjs-durable/commit/27354f0073f78ce524a8d709fc44d1a4e1e4ee57) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A wake that lands while its run's turn is still executing on another instance is no longer lost until the run's `reconcileMs` wake (5 minutes by default).

  - **The wake is kept for the turn.** A wake that cannot take the run's lease because a turn of the run is executing elsewhere (a signal, a child's completion, a step result) records a durable request, and the instance running that turn takes it after it releases the lease and runs the next turn. Before, the instance that received the wake looked again once, found the turn still running and gave up. Runs waiting on a fan of children were covered by a re-check after the turn, but a run waiting on a signal, or on a `ctx.child` whose completion had been overwritten, waited for its reconcile wake.
  - **`ctx.child` writes its timeline placeholder before it starts the child.** A child that finished before the placeholder was written had its completion overwritten by it, and the parent then saw the child as still running.
  - The shared run-dispatch contract (`runRunDispatchContract`) checks a child's completion, a fan's completions and a signal landing mid-turn on the other instance, for every transport.
  - **The SQL transport retries a statement the database rolled back to break a deadlock** (`ER_LOCK_DEADLOCK` on MySQL, `40P01` on Postgres) when it queues, takes or deletes a run, and queues a batch in run-id order. Queueing a batch while another instance took or deleted the same runs could deadlock on MySQL: the starts then waited for the next poll and the wakes resumed on the instance that raised them.

## 0.22.0

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

## 0.21.0

### Minor Changes

- [#406](https://github.com/DavideCarvalho/nestjs-durable/pull/406) [`4d9e840`](https://github.com/DavideCarvalho/nestjs-durable/commit/4d9e8406948130b55de0072e1276bbe06666ddd3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Lease takeover fencing, and `drain()` releases leases on timeout.

  **Fencing.** The engine used to ignore the result of its lease renewals. A turn that stalled past `leaseMs` (a blocked event loop, a long GC pause, a store outage) kept running after another instance had taken the run over, and then wrote its outcome over the new owner's work. Now a renewal that reports the lease lost fences that execution: its completion, failure, suspension, continue-as-new, saga undo, blocked park or remote-turn decision is not written (the store's current state is reported instead), and it no longer releases the lease, which belongs to the new owner. It logs `[nestjs-durable] lost the lease of run … while executing it`. A renewal that throws is still not treated as a takeover, and a lease a turn gives away on purpose (a remote turn suspending on its dispatched decision) is not mistaken for one.

  **Drain.** When `drain(timeoutMs)` (`shutdownTimeoutMs` in `DurableModule`) runs out of budget with runs still executing, it now releases their recovery leases, fencing those turns first, so another instance recovers them on its next pass instead of waiting up to `leaseMs`. It logs which runs it released.

  **`StateStore.releaseRunLock(runId, owner?)`.** The new optional `owner` argument makes the release owner-scoped: only a lease `owner` still holds is cleared. The drain uses it so it never frees a lease another instance already took over. Every first-party store, the in-memory store and `CodecStateStore` implement it; a third-party store that ignores the argument keeps working (it releases unconditionally, as before). The state-store conformance suite in `@dudousxd/nestjs-durable-testing` gains a case for it.

  Also adds `engine.listCheckpoints(runId)`, a pass-through to the store.

- [#406](https://github.com/DavideCarvalho/nestjs-durable/pull/406) [`4d9e840`](https://github.com/DavideCarvalho/nestjs-durable/commit/4d9e8406948130b55de0072e1276bbe06666ddd3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Replay fixtures for CI.

  - The testing kit adds `captureHistory(engineOrStore, runId)`, `serializeRunHistory(history)` and `parseRunHistory(json)`. Use them to capture a run with its checkpoints as a JSON fixture, commit it, and assert it with `assertReplayable(register, parseRunHistory(json))`.
  - `durable export <runId> [--out file]` writes the same fixture from your configured store.
  - Both writers stamp core's new `RUN_HISTORY_FIXTURE_VERSION` (re-exported by the testing kit), and `parseRunHistory` rejects a fixture stamped with any other version. A fixture without `version` is read as version 1.

## 0.20.0

### Minor Changes

- [#405](https://github.com/DavideCarvalho/nestjs-durable/pull/405) [`c6eaaa2`](https://github.com/DavideCarvalho/nestjs-durable/commit/c6eaaa2a1720481ac09e4dd94e8f1626c12431b4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Immediate self-reclaim after a crash, and singleton admission that is safe during a rolling upgrade.

  **Self-reclaim.** Since 0.80, recovery only lists runs whose lease is free or expired. A pod with a stable `instanceId` that was killed without a graceful shutdown (OOM, SIGKILL) therefore waited up to `leaseMs` for its own leases after it restarted. Recovery now also reclaims, right away, the runs still leased by its own `instanceId` whose lease expires before this process's boot time plus `leaseMs`. Those leases were taken by the previous process. Any lease this process takes or renews expires later than that, and a run this process is executing (its in-process run gate is open) is skipped. A gate is held while such a run is recovered, so a resume landing meanwhile queues behind it. Other instances still wait for the lease to expire. `StateStore.listOrphanedRuns` takes an optional fourth argument, `ownedBy: { owner, lockedBefore }`, implemented by every bundled store, the in-memory store and `CodecStateStore`, and covered by the store contract. A custom store that ignores it keeps the 0.80 behaviour. This relies on a live `instanceId` being unique per process.

  **Singleton rolling upgrade.** Replicas older than 0.73 admit singleton runs by a scan and write no `durable:singleton:admitted` tag, so a new replica could start a second run beside an old replica's holder. The holder count now also includes legacy holders: untagged `running`/`suspended`/`cancelling` runs of the key that lack the new reserved `durable:singleton:tracked` marker, or that sit inside the old scan's `limit` window. New replicas write that marker on a singleton run's first execution and on every denial (`singletonAdmissionDenialPatch` now returns `tags`). Admission and terminal settlement remove it, and it is stripped from user start tags (`SINGLETON_RESERVED_TAGS`). Legacy waiters keep their FIFO place, and the new admission takes over once a legacy holder settles. The singleton and production docs no longer tell you to drain singleton runs before upgrading.

## 0.19.1

### Patch Changes

- [#398](https://github.com/DavideCarvalho/nestjs-durable/pull/398) [`696b5b9`](https://github.com/DavideCarvalho/nestjs-durable/commit/696b5b9cb4202cf4fcda7a6cb5ba84072803beea) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Follow-ups to the in-process run gate, settle compare-and-set and orphan-only recovery:

  - A run parked `blocked` releases its lease best effort, like every other settle path. A failing release no longer replaces the `blocked` outcome with the lease error (or surfaces as an unhandled rejection for a background turn).
  - Recovery on a store without `listOrphanedRuns` reclaims at most 500 orphans per pass (oldest first), the same bound as the store query, instead of every orphan at once.
  - `updateRunIf` with a patch that maps to no column is a pure compare on the Prisma and TypeORM stores, like the Drizzle and MikroORM ones: Prisma reported `false` on a match and TypeORM threw. The shared store contract gains a case for it.
  - `WorkflowService.waitForRun` accepts `until: 'terminal'` (it already forwarded it to the engine; the type now says so), which is what awaiting a delayed (`startAt`) run needs.

## 0.19.0

### Minor Changes

- [#395](https://github.com/DavideCarvalho/nestjs-durable/pull/395) [`069d58a`](https://github.com/DavideCarvalho/nestjs-durable/commit/069d58a4ee4d6deaab4ea913a06201c7244854c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Periodic recovery only touches orphaned runs. `recoverIncomplete` runs on every timer tick on every worker, and it listed every `running`/`cancelling` run and issued a lock-attempt UPDATE for each one, including every healthy run whose lease a live turn was renewing. It now asks the store for orphans only, through the new optional `StateStore.listOrphanedRuns(nowMs, limit, namespace?)`: incomplete runs whose lease is free or expired, oldest first, at most 500 per pass. On a healthy fleet that is about zero rows per tick. Every bundled store implements it as one indexed query, `CodecStateStore` forwards it, and the shared `runStateStoreContract` gains a case for it. A store without it still works: the engine lists the incomplete runs as before and skips the leased ones in memory, which still spares the per-run lock attempts.

  With more than 500 orphans at once (a whole fleet restarting with many runs in flight), one pass reclaims 500 and the next tick takes the rest. If you drive `engine.recoverIncomplete()` yourself instead of through the timer poller, call it on an interval, not only once at boot.

- [#395](https://github.com/DavideCarvalho/nestjs-durable/pull/395) [`b30fde6`](https://github.com/DavideCarvalho/nestjs-durable/commit/b30fde6eaff947b2298300157f6c22c6abd7fc93) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A turn's outcome no longer overwrites a run that was cancelled, completed or dead-lettered while the turn ran. A turn settles from a snapshot read before the body ran, and `settleRun` wrote `completed` and `failed` unconditionally (only the `suspended` write re-read the run first, and only looked for `cancelled`). So a plain `cancel()` landing while a step body was still executing was overwritten when the body finished: the run ended `completed` (or `failed`), `run.completed` was emitted and the parent was notified, for a run the operator had cancelled.

  Settling is now a compare-and-set on the run's status through the new optional `StateStore.updateRunIf(runId, expectedStatuses, patch)`, which applies the patch only while the status is one of `expectedStatuses` and resolves whether it wrote. Completed and failed outcomes write over any status except `cancelled`, `completed` and `dead`; a suspend or `blocked` park also leaves a `cancelling` run alone, so a compensating cancel requested mid-turn is finished by its compensation turn instead of parking as `suspended`. A settle that loses the race reports the run's current state and emits nothing.

  Every bundled store implements `updateRunIf` as one conditional `UPDATE … WHERE id = ? AND status IN (…)`: TypeORM, MikroORM, Prisma, Drizzle (SQLite/MySQL and Postgres) and the in-memory store. `CodecStateStore` forwards it, encoding the patch like `updateRun`. A custom store without it still works: the engine re-reads the run and then writes, which narrows the race but cannot close it. The shared `runStateStoreContract` gains `updateRunIf` cases that expect the method, so a custom store running the contract fails them until it adds it.

## 0.18.0

### Minor Changes

- [#382](https://github.com/DavideCarvalho/nestjs-durable/pull/382) [`eefd017`](https://github.com/DavideCarvalho/nestjs-durable/commit/eefd01757304865595a8b32bd96786ed22981a95) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Every bundled store implements `saveCheckpointsIfPending(checkpoints)`: `saveCheckpointIfPending` for a batch, resolving one boolean per entry, in one commit. If it rejects, it wrote nothing.

  - Drizzle Postgres runs one `UPDATE … FROM (VALUES …) WHERE c.status = 'pending' RETURNING c.run_id, c.seq` per 500 rows. A row named twice in one batch goes into a later statement, so the second entry is compared against the first one's write.
  - Drizzle SQLite/libSQL, TypeORM, Prisma and MikroORM run the same conditional `UPDATE` as `saveCheckpointIfPending`, once per entry and in order, inside one transaction.

  The shared `runStateStoreContract` expects the method to exist and checks it: rows already settled are refused, a second copy of a row in one batch is compared against the first, missing rows are never created, rows of different runs can share a batch, a pending-to-pending write leaves the row open for a later entry, and a 600-row batch is written whole. A custom store without the method now fails those cases. The engine still works with such a store, settling each result with its own `saveCheckpointIfPending`.

- [#381](https://github.com/DavideCarvalho/nestjs-durable/pull/381) [`b1e3440`](https://github.com/DavideCarvalho/nestjs-durable/commit/b1e34400fb3f2f9e6c51d3a6309efb99f84bcd1a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A summarized run detail and a fan page no longer read the run's whole checkpoint list.

  - `StateStore` has two new optional methods. `checkpointStats(runId, { group? })` is one `GROUP BY parallel_group, status, <name kind>` that returns counts, seq and timestamp bounds and an attempt sum per bucket. `queryCheckpoints(runId, { group, excludeGroups, statuses, namePrefixes, offset, limit })` pages checkpoints in seq order. Every bundled store implements both, and `CodecStateStore` forwards them.
  - Core's `summarizeRunFromStore` and `pageFanFromStore` build the same `RunDetail` and `FanPage` that `summarizeTimeline` and `pageFan` build from a full read. They read the aggregates, the rows outside wide fans, the folded `fan:` checkpoints, up to 20 failures per fan and the first child edges. While a wide child fan is in flight they also read its completed `signal:child:` rows, because only the payload tells whether a child failed.
  - `StoreRunGateway` uses them when the store has both methods. Otherwise it falls back to the full read. On a 40,000-member step fan, a detail poll now reads 21 rows instead of 40,001, and a page of 100 reads 100.
  - The summarized detail and the fan page carry an `etag`, derived from the run row and the checkpoint buckets. `RunDetailOptions.ifNoneMatch` and `FanPageQuery.ifNoneMatch` let the gateway answer `notModified` after reading only the run and the buckets. The options travel through `ProxyRunGateway` unchanged, so a tenant's poll costs the operator the same.
  - Each store adds a `durable_step_checkpoints_group_idx` index on `(run_id, parallel_group, seq)`.
  - The shared `runStateStoreContract` now expects both methods. It checks them against their in-memory references, and checks that the detail and the pages built on them match the ones built from a full read. The fixture covers step fans, child fans, folded checkpoints, failFast, partial waves and narrow fans.

### Patch Changes

- [#383](https://github.com/DavideCarvalho/nestjs-durable/pull/383) [`cf54b7a`](https://github.com/DavideCarvalho/nestjs-durable/commit/cf54b7ad7a8eafc33020117ceb2b1ec7e1b37333) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - onError polish:
  - Metrics count `run.routed` / `run.unrouted` (`runs.routed`, `runs.unrouted`, `routedByCode`, Prometheus `durable_runs_routed_total{code}`); the OTel bridge adds `durable.run.routed` / `durable.run.unrouted` span events; Telescope tags them `routed` / `unrouted` and `onError:<code>`, with the `reason`.
  - The console shows a failure's `code` and `details` on the failed step and run.
  - The boot warning for an unserved onError route rechecks after 30s, so handlers whose workers start later are not reported.
  - A retry drops the run's `onError:<code>` tag along with the retired handoff.
  - `listCheckpointsByNamePrefix` and `listSignalWaiters` match a prefix literally on every SQL store: `_` / `%` were read as `LIKE` wildcards (and Prisma's `startsWith` on SQLite). New conformance case.
  - Python: `ctx.gather_calls_settled`.

## 0.17.0

### Minor Changes

- [#376](https://github.com/DavideCarvalho/nestjs-durable/pull/376) [`21c8e09`](https://github.com/DavideCarvalho/nestjs-durable/commit/21c8e09de762480a76c38057dfad6d7e3fd84136) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The TypeORM, Prisma and Drizzle stores (SQLite/libSQL and Postgres) implement `saveCheckpointIfPending` and `countCheckpoints`, like the MikroORM and in-memory stores already did.

  - `saveCheckpointIfPending(checkpoint)` is one conditional `UPDATE … WHERE run_id = ? AND seq = ? AND status = 'pending'` that resolves whether a row changed. It never creates a missing row. The engine no longer falls back to a blind `saveCheckpoint` on these stores, so a turn stamping a redispatch deadline can't put a `completed` step back to `pending`.
  - `countCheckpoints(runId, fromSeq, toSeq, statuses)` is one `COUNT(*)` over the `(run_id, seq)` key, so a step fan's join barrier no longer loads the whole run on every result.

  The shared `runStateStoreContract` now expects both methods to exist, as it already does for the other optional methods every bundled store has. It also checks more cases: both seq bounds are inclusive, the count is scoped to its run, a refused write leaves the row unchanged, and the settling write clears the pending row's `wakeAt`. A custom store that leaves out either method now fails those two cases.

## 0.16.2

### Patch Changes

- [#367](https://github.com/DavideCarvalho/nestjs-durable/pull/367) [`c38e83c`](https://github.com/DavideCarvalho/nestjs-durable/commit/c38e83cd9d8261aac254b654bd47a762b7ea9592) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.all` over a `@Step`: `ctx.all(this.lines.processLine, lines, { concurrency })` runs one durable step per input instead of one child workflow per input, and returns the outputs in input order. A child costs a whole run (row, turn, lease, parent signal); a step costs a checkpoint and a dispatch.

  - The steps share a `parallelGroup` (`steps:<firstSeq>:<size>`), so the dashboard renders them as one fan.
  - The engine adds a join barrier for steps: a result resumes the workflow only when no step of the fan is still `pending`, or when one fails. The workflow replays once per settled wave instead of once per result. `Promise.all` over `ctx.step` replays on every result, which makes a fan of N steps cost O(N²) checkpoint reads.
  - `concurrency` sends the steps in waves of that size; `mode: 'failFast'` throws on the first failed step; `waitAll` (the default) throws a `GatherError` with the failed indexes once every step has settled. Every step uses the `@Step`'s retry policy, or the per-call `retries`/`backoff`. A flow-control `queue` and a liveness `timeoutMs` are rejected.
  - A fan's new steps are written `pending` before any is dispatched, so a turn running concurrently with the dispatching one never sends them twice. After the dispatching turn releases its lease, it re-checks the fan, which covers a last result that another instance settled while that turn held the lease.
  - New optional `StateStore.countCheckpoints(runId, fromSeq, toSeq, statuses)`, which the barrier calls on every result. MikroORM and the in-memory store implement it, `CodecStateStore` forwards it, and the shared store contract covers it. A store without it falls back to loading the run's checkpoints.

- [#368](https://github.com/DavideCarvalho/nestjs-durable/pull/368) [`6588790`](https://github.com/DavideCarvalho/nestjs-durable/commit/6588790f6845318c40f8cc9f3eb1648c09a4fd20) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Throughput for wide fans.

  - **`BullMQTransport({ resultConcurrency })`.** Sets how many step results an instance handles at once (default 1). Each result resumes its run inline, so with one at a time a wide fan's results queued up behind a single run turn per pod.
  - **One run's resumes go in order on an instance.** Settling results still runs in parallel. Only the resume each result triggers — the run's turn — is serialized per run on an instance, so the results of one wide step fan don't queue behind each other, and different runs proceed in parallel. A result resumes its run inline, and `execute` admits an instance into a lease it already holds, so two results of one run handled together ran two turns of that run concurrently. That already happened with an in-process transport, which delivers results concurrently, before this option existed.
  - **Due timers come in batches.** `listDueTimers(nowMs, namespace, limit)` returns the most overdue first, at most `limit`. The engine's `resumeDueTimers` loads at most `timerBatchSize` (a new engine option, default 500) per pass and walks it in a shuffled order. Every driving instance runs that pass each tick, so a wave of thousands of due runs — a recovery after an outage, a fan's children waking together — had every instance load all of it and contend for the same leases row by row.
    - All five bundled stores implement `limit` and the ordering, and the shared store contract covers both. A custom store that ignores `limit` still works; the engine then gets the whole due set as before.

## 0.16.1

### Patch Changes

- [#363](https://github.com/DavideCarvalho/nestjs-durable/pull/363) [`8aa3c3e`](https://github.com/DavideCarvalho/nestjs-durable/commit/8aa3c3ecd5753ffee7826fee31fe715b98a45371) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A step result is no longer overwritten back to `pending`. A turn that stamps a pending step's redispatch deadline (or re-dispatches it) wrote the row it had read a moment earlier. If the worker's result landed in between, the step went back to `pending` with no result, the run parked until the deadline, and the step ran a second time.

  - `StateStore.saveCheckpointIfPending` (optional, new) writes only while the stored row is still `pending` and reports whether it wrote. The engine uses it for the redispatch stamp, the redispatch itself, and for settling a step from its result, which also drops a duplicate delivery of the same result. A store without it falls back to `saveCheckpoint`. The MikroORM and in-memory stores implement it, and the shared store contract covers it.
  - BullMQ result jobs are retried (5 attempts, exponential backoff) when the engine's handler throws, failed ones are kept for 24h instead of deleted, and a result given up on is logged. Before, one store error at peak load dropped the result silently.
  - Two starts of the same run id that race between `start`'s existence check and its insert now converge on the winner's run. Before, the loser threw on the primary key; for a `ctx.all`/`ctx.child` child that throw was reported to the parent as "child failed to start", so a child that ran and completed failed the parent's fan.

## 0.16.0

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

## 0.15.0

### Minor Changes

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

## 0.14.0

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

## 0.13.0

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

## 0.12.0

### Minor Changes

- baad9a0: Start a specific workflow version, and take a timed-out run's children with it

  `engine.start` could only ever run whatever version was newest — a version was honoured on `resume`
  but nowhere at start — so a caller that recorded the exact `name@version` it meant to run could not
  actually run it. `StartOptions.version` (and `ChildCallOptions.version`, for `ctx.child` /
  `ctx.startChild`) now targets an exact registered version. Omit it and nothing changes: `latest` is
  still the default. A version that is not registered throws before a run row exists rather than
  falling back to the newest — silent fallback is the failure this exists to prevent. It resolves
  against real registrations only (`register` / `registerRemote` / `remote`); the two synthesized paths
  that exist because nothing is registered — a child inheriting its remote ancestor's routing, and
  convention routing to a live worker group — refuse a pin instead of inventing a version nothing has
  verified.

  `sweepTimeouts` marked a timed-out run `cancelled` directly, bypassing `cancel`, and so never
  cascaded: a child outlived the parent that spawned it with nothing pointing at it, invisible until
  somebody read the runs table by hand. It now runs the same recursive child cascade `cancel` does, so
  the whole subtree goes — children of children included — while keeping the direct terminal write that
  gives the parent its `execution_timeout` error code and keeps the per-tick scan cheap. Idempotent
  under concurrent sweeps, never clobbers a child that already finished, and terminates on a cyclic
  parent-child graph.

### Patch Changes

- 4abdd5b: Pin `awaitingDecisionTaskId` and `parallelGroup` in the cross-adapter column contract

  `DURABLE_CANONICAL_COLUMNS` is the map that makes a store swap safe: every adapter must put the same
  entity property in the same physical column, and each adapter's `column-naming.spec.ts` asserts its
  own mapping against it. Two columns that all four adapters already declare were missing from it, so
  they were the one part of the schema no adapter's spec could disagree about — because nothing said
  what they should be.

  - `durable_workflow_runs.awaiting_decision_task_id` — the REMOTE turn the engine suspended on.
    `completeRemoteDecision` matches against it so that only the currently-awaited turn's decision is
    applied. A store swap that spelled this column differently would not fail loudly; it would apply a
    stale decision to the wrong turn.
  - `durable_step_checkpoints.parallel_group` and `durable_signal_waiters.parallel_group` — the group
    a `ctx.gather`/`ctx.all` fan tags its siblings with, so the dashboard renders them as one parallel
    group rather than N sequential singles. The same physical name in two tables, which is exactly the
    near-duplicate that drifts when nothing pins it.

  Both satisfy the map's admission rule, which is why they belong here and `namespace` did not until
  recently: every adapter declares them. Verified against MikroORM's `entities.ts`, TypeORM's
  `entities.ts`, Drizzle's `schema.ts` and Prisma's `schema.prisma` before adding.

  No runtime behaviour changes — this is the contract getting stricter about what it already required.
  An adapter outside this repo whose naming diverges on these two will now see it as a failing spec
  instead of an "Unknown column" in production.

## 0.11.0

### Minor Changes

- 9ae1bf3: Assert the tenant boundary once, for every adapter.

  `runStateStoreContract` gains a case covering all four paths
  `WorkflowRun.namespace` promises a worker stays inside — picks up, recovers,
  resumes timers for, times out — rather than the three whose signature names the
  parameter. The fourth is `listRuns`, reached by `engine.sweepTimeouts`, and it is
  the one with a write behind it.

  It pins three things a narrower test would miss: that foreign runs do not eat the
  FIFO budget (a store filtering after the limit answers an empty page and looks
  like an idle tenant); that `undefined` is the operator view rather than
  `IS NULL`; and that the unscoped calls still answer across namespaces, so scoping
  cannot have been achieved by making the default restrictive.

  `namespace` also joins `DURABLE_CANONICAL_COLUMNS`, now that every adapter
  carries the column.

## 0.10.0

### Minor Changes

- 0203613: Cover `origin` (and `priority`) in the cross-adapter contract instead of four times over.

  `DURABLE_CANONICAL_COLUMNS` gains `origin` and `priority`. Both were already `origin`/`priority` in
  all four adapters, so nothing changes for a canonical store — but until now each adapter asserted its
  own physical name, which is the per-adapter duplication this map exists to remove. `origin` is the
  easiest of the lot to get wrong quietly: it is a single word, so `snake_case` and `preserve` agree and
  an adapter can look canonical by accident right up until it doesn't.

  `namespace` stays out, and the docblock now says why: only the MikroORM adapter has that column. The
  map is walked as a requirement, so listing a column three adapters don't declare would fail them for a
  divergence they aren't guilty of. That absence records a real cross-adapter gap, not a naming one.

  `runStateStoreContract` gains the `origin` round trip: a run stored with one reads it back, a run
  stored without one reads back `undefined`, and `RunQuery.origin` matches the first and **not** the
  second. That last clause is the point. `undefined` means UNKNOWN and filtering is plain equality, so
  an unattributed run has to match no origin value at all — a store that widened the predicate to
  `= x OR IS NULL` would make its facet look complete while quietly re-attributing runs nobody could
  attribute. An external adapter running this contract now gets that case for free.

## 0.9.0

### Minor Changes

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

## 0.8.0

### Minor Changes

- ad5c510: Fixes a lost-wake race in signal delivery: a signal (e.g. an agent HITL approve/reject) delivered
  in the narrow window between a waiter's buffered-check and its waiter-row registration used to be
  lost forever — the run stayed suspended, the buffered payload sat unpaired, and nothing ever paired
  them (observed in production: the SSE stream never closed).

  Three-piece fix:

  1. **Waiter side** (`waitForSignal`'s both arms, and the remote `waitSignal` command): re-check the
     buffer once more immediately after registering the waiter, so a signal that raced in during the
     initial check is still caught before suspending. On a hit, the waiter removes its OWN row via the
     new exact-match `removeSignalWaiter` — never a blind `takeSignalWaiter(token)`, which deletes ANY
     row for that token and could otherwise steal a different run's waiter that has since claimed the
     same token (`token` is the store's primary key).
  2. **Signal side** (`engine.signal`): after buffering a signal nobody was waiting for, re-check for a
     waiter that registered in that same window; if one appears, reclaim the buffer and deliver
     directly instead of leaving both rows stranded.
  3. **Reconcile safety net**: the due-timer pass that already re-drives event-wait suspends (via their
     `reconcileMs` fallback `wakeAt`) now also pairs a stranded buffer + waiter for a suspended run in
     that batch — closing the residual window where a crash lands between the two ops on either side
     and neither side's own retry logic ever runs again.

  New SPI: `StateStore.removeSignalWaiter(waiter)` deletes the exact `(token, runId, seq)` row (a
  no-op if it no longer matches), implemented across every first-party store (in-memory, MikroORM,
  Drizzle, Prisma, TypeORM) with a shared conformance case.

  Regression-covered: normal (non-racing) signal/`waitForSignal` behavior, the `signalWithStart`
  long-lived entity loop, and the timeout arm (which now cleans up only its own waiter row) are all
  unchanged. Also fixes an unrelated TOCTOU this work surfaced: a `ctx.all` `failFast` cancel landing
  on a sibling mid-turn could be clobbered back to `suspended` by that sibling's own (now-stale) settle
  — `engine`'s suspend-settle re-checks for a concurrent cancel before writing.

## 0.7.2

### Patch Changes

- 3de762c: Fix: remote workflow-turn decisions are now applied durably and instance-agnostically, so a
  multi-instance deployment no longer hangs runs after a `gather_calls`/remote child completes.

  Previously `RemoteWorkflowExecutor` awaited each dispatched turn's decision via an in-memory,
  per-instance `pending` map. With multiple engine instances sharing the broker, the `decisions` queue
  is point-to-point: a decision was often consumed by an instance that did NOT dispatch the turn, which
  had no matching waiter → the decision was dropped → the run stayed `suspended` forever with all its
  steps `completed` (and recovery never re-drove suspended runs). Single-instance never hit it, so it
  surfaced only intermittently in multi-pod deployments.

  Now the engine dispatches the turn and SUSPENDS, recording `WorkflowRun.awaitingDecisionTaskId`. A new
  `completeRemoteDecision` (wired on every instance) applies the decision on whichever instance receives
  it — looked up by `decision.runId`, gated on the awaited `taskId` (stale/duplicate/foreign decisions
  ignored), durably — mirroring how remote step results already work. `RemoteWorkflowExecutor` is now a
  fire-and-forget dispatcher (no in-memory await). Liveness moved to recovery: a run awaiting a decision
  past its `remoteAdvanceSilenceMs` window is re-driven by the timer poller (heartbeat-rearmed), which
  also fixes stuck `suspended` runs never being recovered. The store adapters persist the new
  `awaitingDecisionTaskId` column (additive, nullable; mikro-orm/typeorm autoSchema add it on boot).

## 0.7.1

### Patch Changes

- 99e78fb: Remote `startChild` / `gather_children` child-await `signal:child:` checkpoints now carry the command's `parallelGroup`. The fan group is threaded `command → signal waiter → checkpoint`: the engine stamps each child waiter with the awaiting `startChild` command's group, and the resolving `signal:child:<id>` checkpoint (written when the child notifies the parent) inherits it. Each store adapter persists a nullable `parallel_group` column on the signal-waiter row so it round-trips `put → take`. As a result the dashboard renders a cross-SDK parallel child fan-out (e.g. a Python `ctx.gather_children`) stacked vertically as one parallel group instead of a misleading horizontal `start → s1 → … → sN → end` sequential chain. Additive and backward-compatible: existing waiter rows simply have a NULL group.

## 0.7.0

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

## 0.6.0

### Minor Changes

- 39812a2: Add `deleteRun` to hard-delete a run and its rows.

  New `StateStore.deleteRun(runId)` removes a run plus its checkpoints, signal waiters, and normalized search-attribute rows — implemented in the in-memory store and all four ORM adapters (mikro-orm, typeorm, prisma, drizzle), forwarded by `CodecStateStore`, and covered by the shared store conformance contract. `WorkflowEngine.deleteRun(runId)` builds on it to hard-delete a run and cascade depth-first to its whole subtree (via `getRunChildren`), returning the number of runs removed.

  Unlike `cancel` (which marks a run `cancelled` but keeps it as history), `deleteRun` REMOVES the run — it no longer appears in `getRun`/`listRuns`. Intended for purging a finished run whose data is being deleted; prefer `cancel` first for a live run.

## 0.5.0

### Minor Changes

- 673de96: Make the MikroORM store's physical column naming an explicit, configurable choice instead of an
  implicit dependency on the host ORM's naming strategy.

  The durable entities previously declared no column names, so the physical columns were whatever the
  host MikroORM's naming strategy produced (its default `UnderscoreNamingStrategy` → `snake_case`). The
  TypeORM and Prisma adapters, by contrast, defaulted to the verbatim camelCase property name. Nothing
  pinned the two together, so the adapters silently disagreed on column names — and swapping a deployed
  app from the TypeORM store to the MikroORM store failed at runtime with `Unknown column 'created_at'`
  against the existing (camelCase) table. The divergence was invisible because each adapter's
  conformance suite creates and reads back its _own_ schema.

  `@dudousxd/nestjs-durable-store-mikro-orm` now exposes `durableEntities({ naming })`, which pins
  explicit column names onto the entity schemas per the chosen convention:

  - `'snake_case'` (default) — the canonical convention, matching the Drizzle adapter.
  - `'preserve'` — the verbatim camelCase property name, for an app whose tables were created by the
    old TypeORM/Prisma adapter and that wants to swap to the MikroORM store with **no migration**.
  - a `(property) => string` function for any custom mapping.

  `ENTITIES` is unchanged in spirit — it is now `durableEntities()` (canonical `snake_case`). The store
  keeps resolving column names from ORM metadata, so it adapts to whichever naming the entities were
  registered with.

  `@dudousxd/nestjs-durable-testing` adds `DURABLE_CANONICAL_COLUMNS` (the canonical snake_case column
  contract) and `assertDurableColumns()` — the cross-adapter guard the project lacked. Each adapter can
  now assert its physical columns against one source of truth, so a future divergence is a failing unit
  test instead of a production "Unknown column".

## 0.4.1

### Patch Changes

- b7267da: perf: `getEvent` and `getRunChildren` use targeted store queries instead of fetching and JS-filtering every checkpoint for a run. Adds two **optional** `StateStore` methods (`getLatestCheckpointByName`, `listCheckpointsByNamePrefix`) implemented by all first-party adapters; the engine falls back to the previous `listCheckpoints` scan when a custom store omits them, so this is non-breaking. Cuts per-call rows fetched from O(N) to O(1)/O(k).

## 0.4.0

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

## 0.3.0

### Minor Changes

- a5fd901: **Breaking (0.x minor): `start` now dispatches to a worker instead of running the workflow inline.**

  Previously `engine.start` / `WorkflowService.start` executed the workflow body inline and returned the terminal `RunResult`. Now `start` only **enqueues**: it creates the run as a new `'pending'` status, hands it to a `RunDispatcher`, and returns `{ runId, status: 'pending' }` immediately — the body runs on a worker, so the caller (e.g. an HTTP handler) never blocks on workflow logic.

  **Migration**

  - To await the outcome, use the new `engine.waitForRun(runId)` / `workflowService.waitForRun(runId)` — resolves once the run settles (terminal or suspended). `const { runId } = await start(...); const result = await waitForRun(runId)`.
  - **Default behavior is unchanged for single-process apps**: the default in-process dispatcher executes the run on the same instance (asynchronously), so runs still execute with no extra setup.
  - **Offload to workers**: pass a no-op `runDispatcher` on API/dashboard instances (or set NestJS `worker: false`) so they enqueue-only; worker instances poll `engine.runPending()` (the NestJS `TimerPoller` now does this each tick) to pick up `pending` runs. A broker-backed dispatcher can enqueue to a queue whose workers call `engine.runOne(runId)`.

  New: `RunStatus` gains `'pending'`; engine gains `runOne`, `runPending`, `waitForRun`; `WorkflowEngineDeps.runDispatcher`. The testing harness gains `createTestEngine().run(...)` (start + wait) and the dashboard shows the `pending` state. `StateStore` gains `listPendingRuns(limit)` (oldest-first / FIFO) — **custom store implementations must add it** (all bundled adapters do).

## 0.2.0

### Minor Changes

- Durability hardening (audit follow-up):
  - **Non-determinism detection**: on resume, a step whose name no longer matches the checkpoint recorded at that logical position throws `NonDeterminismError` instead of silently replaying the wrong checkpoint into the wrong step (the classic way a changed-under-flight workflow corrupts a run).
  - **Deterministic sources**: `ctx.now()`, `ctx.random()`, `ctx.uuid()` — checkpointed once and replayed verbatim, so workflows stop being corrupted by raw `Date.now()`/`Math.random()`/`randomUUID()`.
  - **Retry backoff**: `StepOptions` `backoff: 'fixed' | 'exp'` + `backoffMs`/`backoffMaxMs`/`jitter` is now actually applied between local-step retries (it was declared but ignored).
  - **Cancellation safety**: a cancelled/completed run is no longer re-executed by a late worker result or a duplicate `resume()`.
  - **testing**: `assertReplayable(register, history)` replays a recorded run's history against the current workflow code and throws on divergence — a CI guard that catches non-determinism before deploy.
  - **otel**: failed steps now emit a span (with error status), not just completed ones.

## 0.1.1

### Patch Changes

- `ctx.call` now **suspends the run durably** instead of awaiting the worker result in memory. The
  remote step writes a `pending` checkpoint, the run suspends, and the result resumes it on whichever
  engine instance receives it — so a worker/control-plane pod can scale down or crash mid-step without
  losing the run or re-running completed work. This makes `ctx.call` consistent with `ctx.task` /
  `ctx.sleep` (already durable). A step that sets `timeoutMs` keeps the in-memory await + heartbeat path
  (opt-in liveness, single-instance).

  **Breaking:** `engine.start()` / `WorkflowService.start()` now returns `suspended` (not `completed`)
  for a workflow that hits a remote `ctx.call` — the run finishes asynchronously when the result lands.
  Trigger-and-observe consumers are unaffected; anything that awaited `start()` to completion should
  poll the run status (or react to `run.completed`) instead.

  `StepCheckpoint.status` gains `'pending'` (an in-flight remote step), surfaced in the dashboard as a
  "running" node. In-process transports (event-emitter, the in-memory test transport) now deliver
  results on a later tick so the suspend settles first.
