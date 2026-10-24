# @dudousxd/nestjs-durable-store-drizzle

## 0.24.2

### Patch Changes

- [#424](https://github.com/DavideCarvalho/nestjs-durable/pull/424) [`2bc6b22`](https://github.com/DavideCarvalho/nestjs-durable/commit/2bc6b223691d96e7a01ec4bb822b422c191cf612) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Child completions no longer pile up in `durable_buffered_signals`. A run that finished with no parent waiter buffered its completion on `child:<runId>` unconditionally, unless its parent held a byte-identical `signal:child:` checkpoint. So every root run (a controller start, a schedule) left a row behind, and so did a child of a settled `ctx.all` fan of 100+ children (folded into one `fan:` checkpoint) or one whose parent's copy came back from a MySQL `json`/Postgres `jsonb` column with its keys reordered. Nothing ever read those rows.

  The engine now buffers a child's completion only when its parent can still consume it: the parent exists, is not completed or cancelled, and does not already hold the outcome (compared ignoring key order, and counting a folded fan). A new `engine.sweepBufferedSignals()`, called by the NestJS timer poller, deletes the `child:` rows that fail that test, including ones earlier versions left: a few pages of 500 per tick until a pass ends, then every ten minutes; skipped on a namespaced engine. Stores gain `listBufferedSignals` (paged by id, by token prefix) and `deleteBufferedSignals`, covered by the StateStore contract. No schema change.

  A parent that joins a child which already finished settles it at once: `ctx.child` (a caller-chosen id, or a spawn joined later) in the same turn from the child's run row, a fan's children with a placeholder from an earlier turn likewise (with `failFast` honoured), and any child whose deferred start (in-process or a remote `startChild` command) finds it already finished gets its completion re-delivered to the waiter it now has. Before, such a parent waited for the reconcile wake, or forever with reconcile off.

## 0.24.1

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

## 0.24.0

### Minor Changes

- [#406](https://github.com/DavideCarvalho/nestjs-durable/pull/406) [`4d9e840`](https://github.com/DavideCarvalho/nestjs-durable/commit/4d9e8406948130b55de0072e1276bbe06666ddd3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Lease takeover fencing, and `drain()` releases leases on timeout.

  **Fencing.** The engine used to ignore the result of its lease renewals. A turn that stalled past `leaseMs` (a blocked event loop, a long GC pause, a store outage) kept running after another instance had taken the run over, and then wrote its outcome over the new owner's work. Now a renewal that reports the lease lost fences that execution: its completion, failure, suspension, continue-as-new, saga undo, blocked park or remote-turn decision is not written (the store's current state is reported instead), and it no longer releases the lease, which belongs to the new owner. It logs `[nestjs-durable] lost the lease of run … while executing it`. A renewal that throws is still not treated as a takeover, and a lease a turn gives away on purpose (a remote turn suspending on its dispatched decision) is not mistaken for one.

  **Drain.** When `drain(timeoutMs)` (`shutdownTimeoutMs` in `DurableModule`) runs out of budget with runs still executing, it now releases their recovery leases, fencing those turns first, so another instance recovers them on its next pass instead of waiting up to `leaseMs`. It logs which runs it released.

  **`StateStore.releaseRunLock(runId, owner?)`.** The new optional `owner` argument makes the release owner-scoped: only a lease `owner` still holds is cleared. The drain uses it so it never frees a lease another instance already took over. Every first-party store, the in-memory store and `CodecStateStore` implement it; a third-party store that ignores the argument keeps working (it releases unconditionally, as before). The state-store conformance suite in `@dudousxd/nestjs-durable-testing` gains a case for it.

  Also adds `engine.listCheckpoints(runId)`, a pass-through to the store.

- [#406](https://github.com/DavideCarvalho/nestjs-durable/pull/406) [`4d9e840`](https://github.com/DavideCarvalho/nestjs-durable/commit/4d9e8406948130b55de0072e1276bbe06666ddd3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The boot-time schema check now logs one warning when it actually repairs a durable schema.

  `ensureSchema()` (auto-schema) on the MikroORM, TypeORM and Drizzle Postgres stores fixes a schema that is behind the library: a missing table, column or index, a MySQL JSON column still `text`, or a MySQL collation that drifted. It used to do this silently. Now, when it changes something, it logs one line listing each change, for example:

  ```
  [nestjs-durable] store-typeorm repaired the durable schema at boot: added column durable_workflow_runs.origin; created index durable_runs_namespace_status_idx on durable_workflow_runs. The database had drifted from the schema this library version expects …
  ```

  An already-current schema logs nothing. A fresh install (no durable table existed yet) logs nothing too, because creating every table on the first boot is expected, not drift.

  The warning goes to `console.warn` by default. Pass `schemaLogger` (anything with `warn(message)`, such as Nest's `Logger`) to the store constructor, or `{ logger }` as the new optional second argument of `ensureMikroOrmDurableSchema` / `ensureTypeOrmDurableSchema` / `ensureDrizzlePgDurableSchema`. Existing calls compile and behave as before, apart from the warning.

  TypeORM on MySQL: the `text` to `longtext` widen now runs only for columns that are not `longtext` yet, instead of an `ALTER … MODIFY` on every boot.

  The Drizzle SQLite store and the Prisma store have no auto-schema, so they don't log this.

## 0.23.0

### Minor Changes

- [#405](https://github.com/DavideCarvalho/nestjs-durable/pull/405) [`c6eaaa2`](https://github.com/DavideCarvalho/nestjs-durable/commit/c6eaaa2a1720481ac09e4dd94e8f1626c12431b4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Immediate self-reclaim after a crash, and singleton admission that is safe during a rolling upgrade.

  **Self-reclaim.** Since 0.80, recovery only lists runs whose lease is free or expired. A pod with a stable `instanceId` that was killed without a graceful shutdown (OOM, SIGKILL) therefore waited up to `leaseMs` for its own leases after it restarted. Recovery now also reclaims, right away, the runs still leased by its own `instanceId` whose lease expires before this process's boot time plus `leaseMs`. Those leases were taken by the previous process. Any lease this process takes or renews expires later than that, and a run this process is executing (its in-process run gate is open) is skipped. A gate is held while such a run is recovered, so a resume landing meanwhile queues behind it. Other instances still wait for the lease to expire. `StateStore.listOrphanedRuns` takes an optional fourth argument, `ownedBy: { owner, lockedBefore }`, implemented by every bundled store, the in-memory store and `CodecStateStore`, and covered by the store contract. A custom store that ignores it keeps the 0.80 behaviour. This relies on a live `instanceId` being unique per process.

  **Singleton rolling upgrade.** Replicas older than 0.73 admit singleton runs by a scan and write no `durable:singleton:admitted` tag, so a new replica could start a second run beside an old replica's holder. The holder count now also includes legacy holders: untagged `running`/`suspended`/`cancelling` runs of the key that lack the new reserved `durable:singleton:tracked` marker, or that sit inside the old scan's `limit` window. New replicas write that marker on a singleton run's first execution and on every denial (`singletonAdmissionDenialPatch` now returns `tags`). Admission and terminal settlement remove it, and it is stripped from user start tags (`SINGLETON_RESERVED_TAGS`). Legacy waiters keep their FIFO place, and the new admission takes over once a legacy holder settles. The singleton and production docs no longer tell you to drain singleton runs before upgrading.

### Patch Changes

- [#404](https://github.com/DavideCarvalho/nestjs-durable/pull/404) [`b687ab6`](https://github.com/DavideCarvalho/nestjs-durable/commit/b687ab6e6f432cde1c16bb1cebad24fd3cae5044) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Correctness fixes ported from the AdonisJS sibling's audit.

  - `ctx.callEntity` and `ctx.signalEntity` are exactly once across replay. A replay of a `callEntity` still waiting for its reply used to send the operation again (two replays applied it three times), and a turn that died after a `signalEntity` dispatch applied it twice. The operation is now stored durably in the entity's buffer, tagged with the caller's `<runId>:<seq>`, before the caller checkpoints, and the entity's run is created with it. `callEntity` records a pending intent first and marks it as sent with a conditional write that never overwrites a reply that already landed. The entity skips a copy re-sent with the same id. The wake-up is a no-op message, so ops stay in arrival order, and a lost wake-up is recovered by the `reconcileMs` sweep.
  - `ctx.webhook().wait()` consumes a callback that arrived before the wait. `engine.signal` buffered it, but the wait never read the buffer, so the run waited forever. The wait now checks the buffer, registers, then checks again, like `ctx.waitForSignal`.
  - The dashboard's `POST webhooks/:token` buffers an early callback when the token's run exists and isn't terminal, and answers with the run's status. It answers `404` for a non-webhook token, an unknown or terminal run, or a wait that already resolved, and buffers nothing for those. Before, every unmatched POST left a buffered row behind and still answered `404`. A duplicate that races a callback resolving the same wait takes its buffered row back and answers `404`.
  - A child moved to `dead` by recovery (`maxRecoveryAttempts`) now notifies its parent right away as a failed child (`ctx.child` throws, `ctx.all`/`allSettled` record it). Before, the parent waited for its reconcile wake.
  - An empty-string namespace is the `default` pool. An engine configured with `namespace: ''` stamps and polls `'default'`, a run started with `{ namespace: '' }` is stamped `'default'`, and a run stamped `''` is no longer refused by a `'default'` engine's resume and decision guards. An unset namespace is still the operator. Every store writes `''` as `'default'`. The Drizzle stores (SQLite and Postgres) also read legacy `''` rows back as `'default'` and match them with every `'default'` filter. On the MikroORM, Prisma and TypeORM stores, rewrite legacy rows once with `UPDATE durable_workflow_runs SET namespace = 'default' WHERE namespace = ''`. Such rows exist only if an engine ran with `namespace: ''` before this release.
  - bullmq: a negative, NaN, infinite or above-2^31-1 `pingIntervalMs` falls back to the default instead of PINGing about every millisecond. A rejecting heartbeat handler is logged instead of becoming an unhandled rejection. When one `onDecision` handler fails, every handler runs to completion and each failure is reported before the decision is redelivered; before, the redelivery ran the others again while they were still running.
  - event-emitter transport: a rejection while processing a task goes to `onError` instead of becoming an unhandled rejection.

## 0.22.0

### Minor Changes

- [#395](https://github.com/DavideCarvalho/nestjs-durable/pull/395) [`069d58a`](https://github.com/DavideCarvalho/nestjs-durable/commit/069d58a4ee4d6deaab4ea913a06201c7244854c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Periodic recovery only touches orphaned runs. `recoverIncomplete` runs on every timer tick on every worker, and it listed every `running`/`cancelling` run and issued a lock-attempt UPDATE for each one, including every healthy run whose lease a live turn was renewing. It now asks the store for orphans only, through the new optional `StateStore.listOrphanedRuns(nowMs, limit, namespace?)`: incomplete runs whose lease is free or expired, oldest first, at most 500 per pass. On a healthy fleet that is about zero rows per tick. Every bundled store implements it as one indexed query, `CodecStateStore` forwards it, and the shared `runStateStoreContract` gains a case for it. A store without it still works: the engine lists the incomplete runs as before and skips the leased ones in memory, which still spares the per-run lock attempts.

  With more than 500 orphans at once (a whole fleet restarting with many runs in flight), one pass reclaims 500 and the next tick takes the rest. If you drive `engine.recoverIncomplete()` yourself instead of through the timer poller, call it on an interval, not only once at boot.

- [#395](https://github.com/DavideCarvalho/nestjs-durable/pull/395) [`b30fde6`](https://github.com/DavideCarvalho/nestjs-durable/commit/b30fde6eaff947b2298300157f6c22c6abd7fc93) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A turn's outcome no longer overwrites a run that was cancelled, completed or dead-lettered while the turn ran. A turn settles from a snapshot read before the body ran, and `settleRun` wrote `completed` and `failed` unconditionally (only the `suspended` write re-read the run first, and only looked for `cancelled`). So a plain `cancel()` landing while a step body was still executing was overwritten when the body finished: the run ended `completed` (or `failed`), `run.completed` was emitted and the parent was notified, for a run the operator had cancelled.

  Settling is now a compare-and-set on the run's status through the new optional `StateStore.updateRunIf(runId, expectedStatuses, patch)`, which applies the patch only while the status is one of `expectedStatuses` and resolves whether it wrote. Completed and failed outcomes write over any status except `cancelled`, `completed` and `dead`; a suspend or `blocked` park also leaves a `cancelling` run alone, so a compensating cancel requested mid-turn is finished by its compensation turn instead of parking as `suspended`. A settle that loses the race reports the run's current state and emits nothing.

  Every bundled store implements `updateRunIf` as one conditional `UPDATE … WHERE id = ? AND status IN (…)`: TypeORM, MikroORM, Prisma, Drizzle (SQLite/MySQL and Postgres) and the in-memory store. `CodecStateStore` forwards it, encoding the patch like `updateRun`. A custom store without it still works: the engine re-reads the run and then writes, which narrows the race but cannot close it. The shared `runStateStoreContract` gains `updateRunIf` cases that expect the method, so a custom store running the contract fails them until it adds it.

## 0.21.0

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

## 0.20.0

### Minor Changes

- [#376](https://github.com/DavideCarvalho/nestjs-durable/pull/376) [`21c8e09`](https://github.com/DavideCarvalho/nestjs-durable/commit/21c8e09de762480a76c38057dfad6d7e3fd84136) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The TypeORM, Prisma and Drizzle stores (SQLite/libSQL and Postgres) implement `saveCheckpointIfPending` and `countCheckpoints`, like the MikroORM and in-memory stores already did.

  - `saveCheckpointIfPending(checkpoint)` is one conditional `UPDATE … WHERE run_id = ? AND seq = ? AND status = 'pending'` that resolves whether a row changed. It never creates a missing row. The engine no longer falls back to a blind `saveCheckpoint` on these stores, so a turn stamping a redispatch deadline can't put a `completed` step back to `pending`.
  - `countCheckpoints(runId, fromSeq, toSeq, statuses)` is one `COUNT(*)` over the `(run_id, seq)` key, so a step fan's join barrier no longer loads the whole run on every result.

  The shared `runStateStoreContract` now expects both methods to exist, as it already does for the other optional methods every bundled store has. It also checks more cases: both seq bounds are inclusive, the count is scoped to its run, a refused write leaves the row unchanged, and the settling write clears the pending row's `wakeAt`. A custom store that leaves out either method now fails those two cases.

## 0.19.1

### Patch Changes

- [#368](https://github.com/DavideCarvalho/nestjs-durable/pull/368) [`6588790`](https://github.com/DavideCarvalho/nestjs-durable/commit/6588790f6845318c40f8cc9f3eb1648c09a4fd20) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Throughput for wide fans.

  - **`BullMQTransport({ resultConcurrency })`.** Sets how many step results an instance handles at once (default 1). Each result resumes its run inline, so with one at a time a wide fan's results queued up behind a single run turn per pod.
  - **One run's resumes go in order on an instance.** Settling results still runs in parallel. Only the resume each result triggers — the run's turn — is serialized per run on an instance, so the results of one wide step fan don't queue behind each other, and different runs proceed in parallel. A result resumes its run inline, and `execute` admits an instance into a lease it already holds, so two results of one run handled together ran two turns of that run concurrently. That already happened with an in-process transport, which delivers results concurrently, before this option existed.
  - **Due timers come in batches.** `listDueTimers(nowMs, namespace, limit)` returns the most overdue first, at most `limit`. The engine's `resumeDueTimers` loads at most `timerBatchSize` (a new engine option, default 500) per pass and walks it in a shuffled order. Every driving instance runs that pass each tick, so a wave of thousands of due runs — a recovery after an outage, a fan's children waking together — had every instance load all of it and contend for the same leases row by row.
    - All five bundled stores implement `limit` and the ordering, and the shared store contract covers both. A custom store that ignores `limit` still works; the engine then gets the whole due set as before.

## 0.19.0

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

## 0.18.1

### Patch Changes

- [#344](https://github.com/DavideCarvalho/nestjs-durable/pull/344) [`717fa46`](https://github.com/DavideCarvalho/nestjs-durable/commit/717fa46fdd07993d117ca36047c70e0e45371ef4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make singleton admission atomic and durable across engine instances. Persist admitted slots in
  reserved run tags so later same-millisecond starts cannot displace existing holders. Preserve slots
  through sleep, signals, blocked routing, cancellation, recovery and expired execution leases; clear
  admission on terminal settlement. Park denied waiters within the admission transaction so concurrent
  cancellation cannot revive a settled run. All bundled stores support the new atomic admission operation.

  Custom stores must implement `StateStore.tryAdmitSingleton` to use singleton workflows; unsupported
  starts fail before creating a run. Drain existing singleton runs and upgrade all workers together
  before resuming starts, because older active rows have no admission marker. No schema migration is
  required.

## 0.18.0

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

## 0.17.0

### Minor Changes

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

## 0.16.0

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

## 0.15.0

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

## 0.14.0

### Minor Changes

- 9ae1bf3: Enforce the `namespace` tenant boundary in the Drizzle adapter.

  `StateStore` promises that "a worker only picks up / recovers / resumes-timers-for / times-out runs in
  its own namespace". This adapter did not mention `namespace` anywhere: no column, and
  `listIncompleteRuns()` / `listPendingRuns(limit)` / `listDueTimers(nowMs)` declared without the
  parameter at all — legal TypeScript, since an implementation may take fewer arguments than its
  interface, so nothing failed to compile. All four paths were unscoped, and the consequence was not a
  missing dashboard filter: a worker serving tenant A picked up, recovered, resumed and cancelled tenant
  B's runs, in silence.

  Now scoped, every one of them:

  - **picks up** — `listPendingRuns(limit, namespace)`; the foreign runs no longer eat the FIFO budget.
  - **recovers** — `listIncompleteRuns(namespace)`.
  - **resumes timers for** — `listDueTimers(nowMs, namespace)`.
  - **times out** — `listRuns({ namespace })`, the query `engine.sweepTimeouts` issues.

  A run also round-trips its namespace now, which re-arms the engine's own guards that were dead against
  this store: the per-run namespace check on resume, and the blocked-run re-drive, both of which read
  `run.namespace` and treat `undefined` as "belongs to everyone".

  `undefined` means **no restriction** — the operator / control-plane view across all tenants — never
  `namespace IS NULL`. An adapter that filtered on NULL there would look correct in a single-tenant test
  and hide every run in production.

  **Migration — and this adapter is the awkward one.** There is no auto-schema here; you own the
  migration, and skipping it breaks _every_ run query rather than just namespace filtering, because
  drizzle SELECTs every column the schema declares. Exactly the trap `origin` and `priority` set:

  ```sql
  ALTER TABLE durable_workflow_runs ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default';
  CREATE INDEX IF NOT EXISTS durable_workflow_runs_namespace_status_idx
    ON durable_workflow_runs (namespace, status, created_at);
  ```

  The `DEFAULT` is the load-bearing part: SQLite applies it to every existing row as part of the
  `ADD COLUMN`, so pre-existing runs land in `'default'`. That is a fact about them, not a guess — they
  really did execute in the unscoped namespace — and it is the only value that keeps them reachable,
  since a default-namespace worker asking for `'default'` would silently skip a row left NULL and the run
  would sit pending forever. This is the deliberate divergence from `origin`, which stays nullable with
  no default because an origin genuinely cannot be reconstructed after the fact. If you run the bare
  `ADD COLUMN namespace TEXT` anyway, the store reads NULL as `'default'` on both the predicate and the
  mapper so those runs are not orphaned — but the statement above is the one to run.

  **Index.** Unlike `origin`, `namespace` sits on every poll tick's predicate, so the schema declares
  `durable_workflow_runs_namespace_status_idx (namespace, status, created_at)`, mirroring the MikroORM
  adapter's index so a store swap keeps the same plan. Declaring it reaches only a database built or
  migrated from this schema afterwards — an already-deployed one gets nothing until it runs the
  `CREATE INDEX` above, which is why it is spelled out here.

## 0.13.0

### Minor Changes

- 0203613: Persist and filter on a run's `origin`.

  Every adapter stores `WorkflowRun.origin` and honours `RunQuery.origin`. The column is nullable with
  **no default**, which is a deliberate divergence from how each adapter treats `namespace`: an old run
  really did execute in some namespace, so backfilling it to `'default'` states a fact. Which package
  declared its workflow cannot be reconstructed after the event, so the column stays NULL and reads back
  as `undefined` — unknown. Never `'app'`, never `'unknown'`.

  Filtering is plain equality, and a run with no origin therefore matches **no** origin value. It is not
  folded into a bucket to make a facet look complete: unknown runs are reachable only with the filter
  off, so any UI over this has to keep "all origins" as its default view. This matches the in-memory
  reference store, so no adapter disagrees with the interface.

  What each deployment has to do differs, because the adapters differ:

  - **mikro-orm** — the entity fingerprint covers columns, so the boot heal emits the `ALTER TABLE`.
  - **typeorm** — added to the `additive` map, so `ensureTypeOrmDurableSchema` adds it to a table that
    already exists, the same path `events` and `enqueuedAt` took.
  - **drizzle** — no auto-schema here; the consumer owns the migration. Until
    `ALTER TABLE durable_workflow_runs ADD COLUMN origin TEXT;` runs, _every_ run query fails, because
    drizzle selects all declared columns. Same trap `priority` set.
  - **prisma** — the nullable model field emits the ADD COLUMN through Migrate; existing rows land NULL.

  No index. `namespace` is indexed because every poll tick filters on it; `origin` is touched only by the
  dashboard's listing, ANDed with `status` and `workflow`, which are indexed already. A deployment that
  makes origin-filtered listings hot should add the composite index in its own migration — one added
  here would never reach a database that has already booted.

## 0.12.0

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

## 0.11.0

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

## 0.10.5

### Patch Changes

- 25f8000: Add `durableManagedTables()`, returning the fixed list of tables this store creates/manages (`durable_workflow_runs`, `durable_step_checkpoints`, `durable_run_attributes`, `durable_signal_waiters`, `durable_buffered_signals`). Feed it to your ORM's migration differ exclude/skipTables list so a schema diff never proposes dropping them, instead of hand-maintaining a regex denylist (e.g. `skipTables: [/^durable_/]`) that can drift from what the store actually owns.

## 0.10.4

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

## 0.10.3

### Patch Changes

- 99e78fb: Remote `startChild` / `gather_children` child-await `signal:child:` checkpoints now carry the command's `parallelGroup`. The fan group is threaded `command → signal waiter → checkpoint`: the engine stamps each child waiter with the awaiting `startChild` command's group, and the resolving `signal:child:<id>` checkpoint (written when the child notifies the parent) inherits it. Each store adapter persists a nullable `parallel_group` column on the signal-waiter row so it round-trips `put → take`. As a result the dashboard renders a cross-SDK parallel child fan-out (e.g. a Python `ctx.gather_children`) stacked vertically as one parallel group instead of a misleading horizontal `start → s1 → … → sN → end` sequential chain. Additive and backward-compatible: existing waiter rows simply have a NULL group.

## 0.10.2

### Patch Changes

- 1738393: Persist `parallelGroup` on step checkpoints (parity with the mikro-orm adapter). A `ctx.gather`/`ctx.all` fan tags every sibling step with the same group so the dashboard renders them as one "ran in parallel" group, and the core engine carries it (including from a remote/polyglot worker's `recordStep`) — but these adapters had no column for it, so it was dropped on insert and read back as `undefined`, leaving the fan rendered as N sequential rows. Adds a nullable `parallel_group` column to the checkpoint table and maps it in both directions.

  - **typeorm**: auto-added on boot by `ensureTypeOrmDurableSchema` (no manual migration).
  - **drizzle / prisma**: the column is added to the schema/model; consumers manage their own schema, so apply a migration adding the nullable `parallel_group` column (e.g. `prisma migrate` / a drizzle migration). The reference `schema.prisma` now includes it.

## 0.10.1

### Patch Changes

- c1aaacd: Add a transient `cancelling` run status so a compensating cancel is visible (and durable) instead of looking like a still-`running` run.

  **core:** `RunStatus` gains a non-terminal `'cancelling'`. `cancel(runId, { compensate: true })` now persists `cancelling` immediately (and returns it) while the background saga undo runs, then flips to `cancelled` — previously the run stayed `running`/`suspended` with no outward signal that a cancel was in flight. A repeat compensating cancel is idempotent. The status is treated as in-flight everywhere it must be: the singleton admission gate counts it, and recovery re-drives it — so a crash mid-compensation re-derives the cancel intent from the persisted status and finishes the cancel (a compensating cancel is now crash-durable). A non-compensating `cancel()` is unchanged (straight to `cancelled`). For a remote/polyglot workflow (no TS-side compensations) a `cancelling` run finalizes deterministically to `cancelled`.

  **stores (mikro-orm / typeorm / prisma / drizzle):** `listIncompleteRuns()` now also returns `cancelling` runs so recovery re-drives a compensation interrupted by a crash. Columns are free strings — no migration.

  **dashboard / telescope:** render `cancelling` with a distinct in-progress amber (it pulses like a live run; distinct from the grey terminal `cancelled`), add it to the status filter and the state-breakdown chart.

  **codegen:** generated run-status union types include `'cancelling'`.

## 0.10.0

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

## 0.9.0

### Minor Changes

- 39812a2: Add `deleteRun` to hard-delete a run and its rows.

  New `StateStore.deleteRun(runId)` removes a run plus its checkpoints, signal waiters, and normalized search-attribute rows — implemented in the in-memory store and all four ORM adapters (mikro-orm, typeorm, prisma, drizzle), forwarded by `CodecStateStore`, and covered by the shared store conformance contract. `WorkflowEngine.deleteRun(runId)` builds on it to hard-delete a run and cascade depth-first to its whole subtree (via `getRunChildren`), returning the number of runs removed.

  Unlike `cancel` (which marks a run `cancelled` but keeps it as history), `deleteRun` REMOVES the run — it no longer appears in `getRun`/`listRuns`. Intended for purging a finished run whose data is being deleted; prefer `cancel` first for a live run.

## 0.8.2

### Patch Changes

- 6f4e59e: Fix: map every patchable field in the Prisma and Drizzle `updateRun` implementations (previously a subset of fields could be silently dropped on partial updates).

  Internal engine refactors (behavior-preserving): extract `SingletonGate` to concentrate the singleton feature, funnel run settle/suspend transitions through a single `settleRun()`, and extract a `stepCheckpoint()` factory deduping 8 hand-built literals.

## 0.8.1

### Patch Changes

- b7267da: perf: `getEvent` and `getRunChildren` use targeted store queries instead of fetching and JS-filtering every checkpoint for a run. Adds two **optional** `StateStore` methods (`getLatestCheckpointByName`, `listCheckpointsByNamePrefix`) implemented by all first-party adapters; the engine falls back to the previous `listCheckpoints` scan when a custom store omits them, so this is non-breaking. Cuts per-call rows fetched from O(N) to O(1)/O(k).

## 0.8.0

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

## 0.7.0

### Minor Changes

- dc5e0f6: Exactly-once transactional steps — `ctx.transaction(name, (tx) => ...)`.

  Runs your DB work and the step's checkpoint in **one** store transaction, so the business write and the "done" marker commit atomically — a crash can never leave the write done-but-not-checkpointed (which a plain `ctx.step` re-runs on recovery). `tx` is the store-native transaction handle (a TypeORM/MikroORM `EntityManager`, a Prisma tx client, or a Drizzle tx); do your writes on it. Needs a SQL store (all bundled SQL adapters implement the new optional `StateStore.transaction`); errors on a store without it. This is the DBOS-style exactly-once guarantee for same-database work.

- 8ba981d: Signal-with-start (durable entities), cancel→child propagation, and low-latency dispatch.

  - **Reliable signals + `signalWithStart`**: a signal sent with no waiter is now **buffered** (FIFO per token) and delivered to the next `waitForSignal` — signals are never lost to timing. `engine.signalWithStart(workflow, input, runId, { token, payload })` / `workflowService.signalWithStart(...)` ensures a run exists then delivers a signal, race-free — the canonical **durable-entity / accumulator** pattern (one long-lived run per key fed events by many calls). New `StateStore.bufferSignal` / `takeBufferedSignal` (custom stores must add them; all bundled adapters do).
  - **Cancellation cascades to children**: `engine.cancel(parent)` now cancels the runs it started via `ctx.child` / `ctx.startChild` (recursively), and no longer clobbers an already-finished run.
  - **Low-latency cross-pod dispatch**: a run enqueued on one instance (e.g. an API pod) nudges worker instances over the control plane (`engine.onEnqueued`) to pick it up at once instead of on the next poll. The dashboard `/metrics` adds `durable_pending_runs` (dispatch backlog) + `durable_dead_runs` (DLQ size) gauges.

## 0.6.0

### Minor Changes

- c99508d: Self-healing recovery + non-blocking dashboard actions.

  - **Lease renewal**: while a run executes, the engine renews its recovery lease (every `leaseMs/2`), so a live worker keeps a long run while a **crashed** worker's lease still expires. `execute` now holds the lease for the whole run on every entry path (sweep, signal, remote result, dashboard), so a run is never double-executed. New `StateStore.renewRunLock(runId, owner, leaseUntilMs)` — **custom stores must add it**.
  - **Periodic orphan recovery**: the NestJS `TimerPoller` now calls `engine.recoverIncomplete()` each tick, so a run orphaned by a crashed worker self-heals within ~`leaseMs` instead of only on the next boot.
  - **Non-blocking control actions** (fixes the `/durable` retry/cancel request hanging): `retry` now re-enqueues via the new `engine.requeue(runId)` (sets `pending` + dispatches) and `cancel({ compensate })` runs the undo in the background — neither replays the workflow inline in the HTTP request anymore. A worker does the work.

## 0.5.0

### Minor Changes

- a5fd901: Typed search attributes — query runs by structured data, not just exact-match tag labels.

  - **Start**: `start(wf, input, id, { searchAttributes: { amount: 200, tier: 'pro' } })` stamps typed, queryable data on a run.
  - **Query**: `RunQuery.attributes` takes `{ key, op, value }` predicates ANDed together, with `eq/ne/gt/gte/lt/lte` — so range queries like `amount >= 200 AND tier = 'pro'` work. Applied in-process after the coarse workflow/status/tag filters, so it's portable across all store adapters (typeorm/prisma/mikro-orm/drizzle gain a `searchAttributes` JSON column).
  - **Dashboard**: an attribute filter box (`amount:gte:200, tier:eq:pro`), attribute pills on the run detail, and bulk retry/cancel honoring the same predicates. API: `GET /runs?attr=key:op:value` (repeatable).

## 0.4.0

### Minor Changes

- f2260da: feat: named events — ctx.waitForEvent + engine.publishEvent

  Name-based pub/sub on top of the signal machinery, for choreography beyond point-to-point signals. A
  run suspends on `ctx.waitForEvent('payment.settled', { match: { orderId }, timeoutMs })` and resumes
  with the payload; `engine.publishEvent(name, payload)` (also `WorkflowService.publishEvent`) fans out
  to every waiting run whose `match` the payload satisfies, returning how many it resumed. The match is
  encoded in the waiter token, so the only store change is a new `listSignalWaiters(prefix)` method
  (implemented across in-memory, TypeORM, MikroORM, Prisma, Drizzle) — no new schema.

## 0.3.0

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

## 0.2.1

### Patch Changes

- 6979d60: fix: list runs newest-first

  `store.listRuns` now orders by `createdAt DESC` (was `ASC`) across every adapter (in-memory,
  TypeORM, MikroORM, Prisma, Drizzle), so the dashboard shows the most recent run on top instead of
  buried at the bottom.

## 0.2.0

### Minor Changes

- 3f79533: feat: dead-letter queue — `maxRecoveryAttempts` + `dead` run status

  Crash recovery now counts attempts per run (`WorkflowRun.recoveryAttempts`); once a still-`running`
  run exceeds the engine/module `maxRecoveryAttempts`, it's moved to the new terminal **`dead`** status
  instead of being retried forever — so a poison pill that crashes the process every boot becomes an
  inspectable dead-letter entry, not a crash loop. The new column is persisted by all four store
  adapters (TypeORM auto-schema self-heals it; Prisma/Drizzle/MikroORM schemas updated), and `dead` is
  added to the dashboard/codegen status unions. Omit `maxRecoveryAttempts` for the prior unlimited-retry behaviour.

## 0.1.3

### Patch Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

## 0.1.2

### Patch Changes

- Record a step's **input** on its checkpoint, alongside the output. A remote step's `ctx.call` args
  are now persisted and surfaced in the dashboard step panel ("Input" + "Output" shown separately,
  instead of only the output) — so you can see what a step was called with, not just what it returned.
  Stored as a nullable column across all four store adapters; the in-memory store carries it for free.

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
