# @dudousxd/nestjs-durable-telescope

## 0.10.2

### Patch Changes

- [#454](https://github.com/DavideCarvalho/nestjs-durable/pull/454) [`e6bf57a`](https://github.com/DavideCarvalho/nestjs-durable/commit/e6bf57add076586f7ef10aa967c874025019ade5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept `@dudousxd/nestjs-telescope` 3.x as a peer (tested against 3.0.0).

## 0.10.1

### Patch Changes

- [#445](https://github.com/DavideCarvalho/nestjs-durable/pull/445) [`582efc7`](https://github.com/DavideCarvalho/nestjs-durable/commit/582efc7b154807f23d53e55f18bd766ce0c28fc1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Widen peer ranges so apps on the current releases install without peer conflicts: `@dudousxd/nestjs-durable` accepts `@dudousxd/nestjs-context` 1.x (`>=0.1.0 <2.0.0`), `@dudousxd/nestjs-durable-telescope` accepts `@dudousxd/nestjs-telescope` 2.x (`>=1.0.0 <3.0.0`), and `@dudousxd/nestjs-durable-diagnostics` accepts `@dudousxd/nestjs-diagnostics` 0.3 to 0.8 and later 0.x (`>=0.3.0 <1.0.0`, previously `^0.3.0`). No code changes: the APIs these packages use are unchanged in context 1.1.0, telescope 2.0 and diagnostics 0.8.0.

## 0.10.0

### Minor Changes

- [#443](https://github.com/DavideCarvalho/nestjs-durable/pull/443) [`08a85be`](https://github.com/DavideCarvalho/nestjs-durable/commit/08a85bebd516144fe5e50c72e3b7b0b5182c311f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Start a workflow when another one finishes, without the finishing workflow knowing about it. When a run settles, the engine publishes `run.completed:<workflow>` or `run.failed:<workflow>` with the run's input, output, error, tags and search attributes, and `@OnWorkflowCompleted(Workflow, { where, input })` / `@OnWorkflowFailed(Workflow, { where, input, statuses })` subscribe to it. With a class ref, the subscriber's `run` input is type-checked against the event, or against what `input` builds from it.

  Delivery is exactly once per settled run and subscriber. The terminal status write also tags the run `durable:lifecycle:pending`; once the subscribers are started the engine replaces it with `durable:triggered:<subscriber>` tags, and the new `engine.sweepLifecycleEvents()` (called by the timer poller and the testing harness's `tick`) publishes any run left marked. A subscriber whose `where` throws or whose start fails is reported as `run.trigger_failed`. Nothing is marked or published for a workflow nobody subscribes to.

  `onEvent` entries (in `@Workflow({ onEvent })` and `@OnDurableEvent`) can now be `{ event, where, input }`: `where(payload)` decides per event whether the workflow starts, and `input(payload)` builds its input. `getOnEvents` now returns these entries instead of only names.

  The two runs are linked both ways. The run detail carries `triggered` and `triggeredBy`, and the dashboard's run header lists them. `WorkflowService.triggeredRuns(runId)` (read from the settled run's tags, so any instance can answer it), `lifecycleSourceOf(run)` (read from the started run's id) and `lifecycleRunId(...)` give the same links in code. The engine emits `run.triggered` and `run.trigger_failed`, counted by the OTel metrics (`runs.triggered`, `runs.triggerFailed`) and tagged in Telescope.

  Retention never prunes a run still tagged `durable:lifecycle:pending`, in every store adapter, so a short retention window cannot delete a run before its lifecycle event is published.

  A lifecycle event is owed to every subscriber, not only the ones the settling instance has. The terminal write also tags the run `durable:lifecycle:owed:<subscriber>` (`LIFECYCLE_OWED_TAG_PREFIX`) for each subscriber registered locally or announced by a live worker: TS workers list each workflow's `onEvent` events in their descriptor's new `subscribes` field, read through `engine.lifecycleSubscribers(workflow, kind)` and cached for 5s. Each instance, live or through the sweep, starts only the owed subscribers it has, and `durable:lifecycle:pending` goes with the last owed tag. An owed subscriber nobody announces or has is dropped 24h after settle (`LIFECYCLE_ORPHAN_MS`) and reported as `run.trigger_failed`. A run marked only `pending` has an unresolved owed set (see below).

  `ctx.waitForRun(runId, { timeoutMs })` (or `ctx.waitForRun(WorkflowClass, runId)`, typed by that workflow) waits for any run to settle and resumes with its `WorkflowLifecycleEvent`. It resolves at once for a settled run, follows a continue-as-new chain to its end, throws `SignalTimeoutError` on timeout and fails with a non-retryable `run <id> not found` for an unknown id. Every settle delivers to its waiters, and the lifecycle sweep (`engine.sweepRunWaits`) delivers the ones a crash left behind.

  `engine.republishLifecycle({ runId } | { workflow, kind, since, until, subscriber, limit })` (also on `WorkflowService` and the store-backed `RunGateway`) publishes settled runs again without the marker, to backfill a subscriber added later or retry one that failed; subscribers already started are not started again. The dashboard adds a "Republish lifecycle event" action on a settled run with subscribers (`POST runs/:id/republish-lifecycle`, gated like retry/cancel, with `lifecycleSubscribers` on the run detail), and the CLI adds `durable lifecycle:republish --run | --workflow [--since] [--until] [--subscriber]`, with an `engine` exported from the config.

  `debounce` and `batch` coalescing take a `key`: `EventBatchConfig.key(input)` gives each distinct key its own accumulator run (`accumulatorRunId(target, key)`; the unkeyed id is unchanged). `@OnWorkflowCompleted` / `@OnWorkflowFailed` accept `debounce: { windowMs, key }` or `batch: { maxSize, windowMs, key }`, with `key` typed by the subscriber's input and a batched subscriber's `run` checked against `{ events }`; both at once, or a different `@Workflow({ debounce | batch })`, is rejected.

  A subscriber's trace links to the run that started it. `attachDurableOtel` gives a lifecycle-started run's root span a span link to the source run's span and the attributes `durable.lifecycle.source_run_id` and `durable.lifecycle.kind`. To make that work across processes, the bridge installs a run trace provider (`engine.setRunTraceparent`), the terminal write of a run some workflow subscribes to records the run span's traceparent as a `durable:lifecycle:trace:<traceparent>` tag (`LIFECYCLE_TRACE_TAG_PREFIX`, `lifecycleTraceparentOf`), and the subscriber's `run.started` event carries it as `sourceTraceparent`. Both metrics collectors count `run.triggered` by workflow and subscriber (`triggeredBySubscriber`; Prometheus `durable_runs_triggered_total{workflow,subscriber}`).

  `engine.workflowLifecycle(workflow)` answers who starts whom (`WorkflowLifecycleLinks`: `startsOnSettle` and `startedBy`, each a `LifecycleSubscriptionLink` with its kind and whether it is local or announced, filtered with `where`, mapped with `input`, or debounced/batched and keyed), from the local registry and the fleet's announcements; `parseLifecycleEvent(name)` reads a lifecycle event name. The store-backed `RunGateway` exposes it as `workflowLifecycle(workflow)` and on `RunDetail.workflowLifecycle`. The dashboard adds a workflow page (`#/workflow/<name>`, linked from the run header, served by `GET workflows/:name/lifecycle`) listing "Starts when it settles" and "Started by", each entry linking to that workflow's page.

  Python workflows subscribe too: `@worker.workflow("notify", on_workflow_completed="ingest")`, `on_workflow_failed=` (a name, a registered class, or a list) and `on_event=[...]` (also on `WorkflowWorker.workflow` and `@workflow`), with `run_completed_event` / `run_failed_event` helpers. The Python worker announces them as `subscribes`, pinned by the cross-SDK fixture `descriptor-subscribes.json`. The engine starts a subscriber it knows only from announcements by name, on a live worker group of that name, with the payload as input and the usual deterministic id, from the live publish, the sweep, `republishLifecycle` and `publishEvent`; one registered locally too is started once, and one a Node engine announces is left to that engine, which applies its `where` and `input`. Announced subscribers have no `where` or `input`.

  The lifecycle sweep pages through marked runs, skipping those it cannot act on, until it has acted on `limit` runs or examined 1000, so runs owed only to other instances' subscribers cannot starve it; `sweepRunWaits` likewise skips waits on runs still in flight.

  Subscriptions are announced on every transport. Each engine with `onEvent` subscriptions keeps a lifecycle registry run in the state store (`engine.heartbeatLifecycleRegistry()`, called by `sweepLifecycleEvents`): a completed run of the internal `__lifecycle_registry` workflow (`LIFECYCLE_REGISTRY_WORKFLOW`), id `__lifecycle_registry:<instanceId>` (`lifecycleRegistryRunId`), its subscriptions in `input` (`LifecycleRegistryEntry`) and its `updatedAt` refreshed every 10s (`LIFECYCLE_REGISTRY_HEARTBEAT_MS`). Fresh rows (`LIFECYCLE_REGISTRY_TTL_MS`, 35s) count as subscriptions a Node engine announces, next to worker descriptors' `subscribes`, so with the db, SQS, event-emitter or no transport a subscriber registered on another instance is owed its events too. Any engine deletes rows not refreshed for 10 minutes (`LIFECYCLE_REGISTRY_STALE_MS`). Retention never prunes them and does not count them toward `maxCount` (every store adapter leaves the registry workflow out of a policy's scope, and `retentionKeeps(tags)` also checks `LIFECYCLE_REGISTRY_TAG`), and `RunQuery` gains `excludeWorkflows`, which the store-backed run gateway uses to keep them out of the dashboard's lists, counts and pickers.

  A run some workflow subscribes to records its root span's traceparent with its first suspend as well, so a subscriber's span links to the source run even when the run was resumed and settled in a process that never saw its first turn. No store write is added.

  The tenant proxy carries the lifecycle verbs: `RunRequestKind` gains `{ kind: 'republishLifecycle', target }` and `{ kind: 'workflowLifecycle', workflow }`, answered by `RunRequestResponder` (a one-run republish refuses another tenant's run like `retry`; a by-workflow one is read over the requester's namespace, through the new `namespace` field of `RepublishLifecycleTarget`) and sent by `ProxyRunGateway.republishLifecycle` / `workflowLifecycle`. Over the proxy, `workflowLifecycle` and a run detail's `workflowLifecycle` / `lifecycleSubscribers` list only the tenant namespace's subscribers (`engine.workflowLifecycle(workflow, { namespace })`: registry runs in it, descriptors serving it by `namespace` or `@<tenant>` group, the engine's own when it is that namespace's engine). Against an operator that does not know the verbs the proxy fails with a `RunGatewayError` coded `unsupported-request` instead of timing out, and the dashboard answers 501.

  A settled run is owed only to the subscribers of its own namespace. An engine with no namespace that settles a tenant's run no longer marks it as owed to subscribers announced in other namespaces, which never started and kept the run from being pruned. `engine.lifecycleSubscribers(workflow, kind, namespace?)` takes the run's namespace (without it, every namespace's): this engine's subscribers when it has no namespace or the run's, registry runs written by an engine in that namespace or with none, and worker descriptors serving that namespace. `LifecycleRegistryEntry` gains `engineNamespace: string | null`, read with `lifecycleRegistryNamespace(input, rowNamespace)`, since an engine with no namespace and one in `default` both keep their registry run under `default`; a row written without it under `default` reads as every namespace, so a rolling deploy loses no subscriber. A namespaced engine reads its namespace's registry runs and `default`'s. The orphan check, the live publish, the sweep and `republishLifecycle` use the same scope, so owed tags already written for another namespace are dropped as orphans after 24h.

  The dashboard and Telescope show every lifecycle feature. A run detail carries `lifecycleDeliveries` (a `LifecycleDelivery` per subscriber of a settled run: `started` with its run and status, `owed` with `owedSince` and `orphanAt`, `coalesced` with the accumulator run when derivable through the new `engine.coalescedSubscribers(run)`, or `not-started`; `LifecycleDeliveryState`, `lifecycleDeliveriesOf`), `waitsFor` and `awaitedBy` (`RunWaitLink`, the `ctx.waitForRun` waits on either side), and `triggeredBy` as a `LifecycleSource` with the source run's `status`, `namespace` and trace id (`traceIdOfTraceparent`). The summarized detail's ETag covers what those links read (`extendEtag`). `RunWaiting.on` gains `'run'` for a run parked in `ctx.waitForRun`. Through the tenant proxy, waiting runs of other namespaces are dropped and a linked run in another namespace keeps only its id. The console shows "Lifecycle subscribers", "started by" with the source trace id and a copy button, "Waiting for run" / "Awaited by", a "lifecycle pending" filter chip, and per-subscriber "N started · M failed" counts on the workflow page (`triggerCounts`, `WorkflowLifecyclePage`), counted by the new `MetricsSnapshot.triggerFailedBySubscriber` (Prometheus `durable_runs_trigger_failed_total{workflow,subscriber}`). Telescope records `run.triggered` and `run.trigger_failed` with a family, tags a lifecycle-started run's `run.started` with `lifecycle`, `source:<run id>` and `sourceTrace:<trace id>`, records it under a span linked to the source run's trace (`runSpanContext`), and the Workflows dashboard adds "Failed triggers", "Owed lifecycle events" and "Owed runs" under "Needs attention" and a "Lifecycle" section (`durable.failedTriggers`, `durable.owedLifecycle`, `durable.lifecycleTriggers`).

  A subscriber whose start failed is recorded on the settled run: the update that drops its owed tag (live publish, sweep, republish or orphan drop) adds `durable:trigger_failed:<subscriber>` (`LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX`, read with `triggerFailedSubscribersOf`), and a later successful start removes it, with no extra store write. `LifecycleDeliveryState` gains `'failed'` and `LifecycleDelivery` an optional `error`; the message is not stored, so `lifecycleDeliveriesOf` leaves `error` unset. The tag stays out of the lifecycle event's `tags`. A republish retries a failed debounced/batched subscriber too. The dashboard shows a **failed** row with a per-subscriber **Republish** button (`durableClient.republishLifecycle(id, subscriber)`), filling in the error from a `run.trigger_failed` event seen while the page is open.

  The run view adds an **Events** panel: the run's engine events as the SSE stream delivers them (type, UTC time, links to the run a `run.triggered` started, the subscriber of a `run.trigger_failed` with its error, a child step's child run, and the run that started this one), the last 200 kept in memory and nothing stored. The stream stays open while a settled run is open, refetching its detail on `run.triggered` and `run.trigger_failed`. The client's `EngineEvent` type gains the `run.blocked`, `run.routed`, `run.unrouted`, `run.triggered` and `run.trigger_failed` types and their `namespace`, `error`, `reason` and `triggeredRunId` fields.

  `StateStoreContext` (the store conformance suite) gains `flushStatementLog`, which resolves once `statements` / `statementLog` count every statement sent before it. The Prisma DB spec implements it with a marker query, so a statement Prisma reports late is no longer counted as the next call's, which made the Postgres "settleCheckpointsIfPending sends none of the input" and "listCheckpointsForReplay reads no input column" cases fail intermittently.

  A run that settles before its owed set is known is not lost. The terminal write no longer waits for the fleet's announcements: it uses the last read and refreshes it in the background. With no usable read (an engine that just booted, or whose last read failed) it tags the run `durable:lifecycle:pending` alone, meaning the owed set is unresolved; the first publish with a good read (live or sweep, any instance) resolves it to every subscriber of the run's namespace that has not started or failed, and until then an instance starts only its own subscribers that do not coalesce. Runs marked only `pending` by earlier builds resolve the same way. The sweep also heals runs settled in the last 2 minutes (`LIFECYCLE_HEAL_WINDOW_MS`) that missed a subscriber announced after the settling engine last read the announcements, reading each source workflow's recent runs with the new `RunQuery.updatedAfter` (every store adapter, covered by the conformance suite); a later subscriber is backfilled with `republishLifecycle`. The registry is read a page of 1000 rows at a time to the end. `triggeredSubscribersOf(tags)` reads a run's triggered subscribers.

  Concurrent publishers of one run no longer overwrite each other's tags. Every lifecycle tag update (live publish, sweep, heal, republish, orphan drop) holds the run's lease (`tryLockRun`, owner `<instanceId>#lifecycle#<uuid>`), retrying for about 1.5s; a sweep skips a run it cannot lease until its next tick, and a republish reports it in `failed` as `run <id> is being published elsewhere; try again`. `run.triggered` and `run.trigger_failed` are emitted by the publish whose write recorded them, once per subscriber. A debounce/batch accumulator counts a routed event once by its id (the lifecycle event's source run), remembering the last 1000 ids across bursts (`ACCUMULATOR_SEEN_MAX`), so a lifecycle event published twice never counts twice.

  `republishLifecycle` requires `limit` to be a positive integer. Through the tenant proxy, a `limit` that is not one, or a `subscriber` that does not subscribe to the workflow in the tenant's namespace, is refused with a `RunGatewayError` coded `bad-request` (`BAD_RUN_REQUEST`; HTTP 400 from the dashboard), and a larger `limit` is lowered to 1000 (`TENANT_REPUBLISH_MAX_LIMIT`). The responder checks the subscriber with the new optional `RunGateway.lifecycleSubscribers(workflow, kind, namespace)`, which the store-backed gateway implements.

  Two `@OnWorkflowCompleted` / `@OnWorkflowFailed` decorators on one workflow with the same `debounce` / `batch` settings no longer fail when each writes its own `key` arrow: keys compare by source text. Keys written differently still fail at decoration.
  A delivery into a debounce/batch accumulator is recorded on the settled run: the publish that routes it (live, sweep, resolve, heal or republish) adds `durable:coalesced:<subscriber>` (`LIFECYCLE_COALESCED_TAG_PREFIX`, read with `coalescedSubscribersOf`) in the same tag write, and emits `run.triggered` exactly when it adds that tag, so a healed coalesced delivery is reported once. The heal counts the tag as known and never routes that subscriber again, a republish routes it to a run without the tag (so a coalescing subscriber added later is backfilled, like any subscriber without a `durable:triggered:` tag) and to a run with it only when the run also carries its `durable:trigger_failed:` tag, and never marks a coalesced-tagged run owed again to an instance that cannot deliver it, `lifecycleDeliveriesOf` reports it as `coalesced`, and `isLifecycleTag` keeps it out of the event payload. The heal derives both its subscription filter and its run window from the `nowMs` it is given.

## 0.9.3

### Patch Changes

- [#430](https://github.com/DavideCarvalho/nestjs-durable/pull/430) [`cccf750`](https://github.com/DavideCarvalho/nestjs-durable/commit/cccf7505aa92b7bd2519aef844c56c231921cc60) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Lifecycle events are recorded once across a deployment, by the instance that produced them. With a
  control plane every instance hears every event (that is what lets the dashboard live-tail a run from
  any pod), and the Telescope watcher, the core metrics, the OpenTelemetry spans and metrics and the
  diagnostics bridge each recorded every event they heard: once per pod. In a 12-pod deployment one
  40,000-step fan wrote 612,000 Telescope entries instead of about 80,000, and that write load saturated
  the database the run itself was using. The core now marks an event re-delivered from another instance
  (`isRemoteEvent(event)`), and those surfaces skip it. They read the mark by symbol, so an older core
  keeps working as before.

## 0.9.2

### Patch Changes

- [#429](https://github.com/DavideCarvalho/nestjs-durable/pull/429) [`05bf898`](https://github.com/DavideCarvalho/nestjs-durable/commit/05bf898b6bdca4d9a3a2dba9cbfcee7d4b4dae98) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A run's trace and root-span ids are hashed once per run instead of on every lifecycle event. A wide
  step fan emits tens of thousands of events for the same run, and each one hashed the run id up to
  four times (two sha256 digests per call). The ids of the last 512 runs are kept; they are still a
  pure function of the run id, so a run whose ids were evicted hashes back to the same ones.

- [#429](https://github.com/DavideCarvalho/nestjs-durable/pull/429) [`2e4a236`](https://github.com/DavideCarvalho/nestjs-durable/commit/2e4a236c57157070836ded7215e9226d5b056bec) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The Workflows panels (success rate, throughput, durations, runs over time) keep counting runs after a
  wide step fan. They read the latest 5,000 `durable` entries and counted the `run.*` events among
  them, but one 40k-step fan records 80k step entries, so for hours afterwards the page held only steps
  and every panel showed no runs. Run lifecycle entries now carry a `familyHash` (`durable:run.started`,
  `durable:run.completed`, …), an indexed column on every Telescope store, and the panels read those
  families directly. Run entries recorded before this release are still read the old way, below the
  oldest entry with a family, so the panels keep the runs from before the upgrade.

## 0.9.1

### Patch Changes

- [#383](https://github.com/DavideCarvalho/nestjs-durable/pull/383) [`cf54b7a`](https://github.com/DavideCarvalho/nestjs-durable/commit/cf54b7ad7a8eafc33020117ceb2b1ec7e1b37333) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - onError polish:
  - Metrics count `run.routed` / `run.unrouted` (`runs.routed`, `runs.unrouted`, `routedByCode`, Prometheus `durable_runs_routed_total{code}`); the OTel bridge adds `durable.run.routed` / `durable.run.unrouted` span events; Telescope tags them `routed` / `unrouted` and `onError:<code>`, with the `reason`.
  - The console shows a failure's `code` and `details` on the failed step and run.
  - The boot warning for an unserved onError route rechecks after 30s, so handlers whose workers start later are not reported.
  - A retry drops the run's `onError:<code>` tag along with the retired handoff.
  - `listCheckpointsByNamePrefix` and `listSignalWaiters` match a prefix literally on every SQL store: `_` / `%` were read as `LIKE` wildcards (and Prisma's `startsWith` on SQLite). New conformance case.
  - Python: `ctx.gather_calls_settled`.

## 0.9.0

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

## 0.8.1

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

## 0.8.0

### Minor Changes

- d8dc3cc: Give every workflow turn and every step handler a Telescope batch, so what durable work _does_ is
  correlated to the work that did it.

  `@dudousxd/nestjs-durable-telescope` opened no batch at all. It subscribed to engine events and
  recorded an entry per event, which tells you that `step.failed` happened — and nothing about what the
  step was doing when it failed. The queries it issued, the outbound calls it made and the exception it
  threw were recorded by Telescope's other watchers with no batch and no trace context active, so they
  landed traceless: unfindable from the run, and invisible in the trace waterfall. Recording an event
  after the fact cannot fix that, because by then the body has returned.

  **The seam.** Wrapping execution needed a hook, and the engine's existing one is the wrong shape:
  `engine.use` (`StepInterceptor`) fires only around the in-process `localStep` primitives —
  `ctx.now`, `ctx.sideEffect`, `ctx.task`'s dispatch step, saga compensations — because a user's
  `ctx.step` is _always dispatched_, so its handler runs inside a transport callback or a worker
  process where no engine is in scope at all. So core gains a process-level registry,
  `useDurableExecution(wrapper)`, folded in at the three places a unit of durable work actually
  executes:

  - `WorkflowEngine.runExecution` — one whole TS workflow turn, including the store writes that bracket
    the body, because those are precisely the queries you want attributed to the turn that issued them;
  - `runStepHandler` in core's `protocol.ts` — the one function every transport (BullMQ, SQS,
    event-emitter, DB, in-memory) funnels a step handler through;
  - `StepWorker.processTask` / `WorkflowWorker.processTask` in `@dudousxd/durable-worker` — the same
    two units on the thin/co-located worker path, which has no engine to hang a hook off. That is why
    the registry is process-level rather than per-engine.

  Nothing is registered by default: with an empty registry `runDurableExecution` returns the body's own
  promise without allocating a chain, so a host that wires no observability pays nothing. A wrapper's
  return value and its throws are deliberately discarded — the body's outcome is the only thing that
  can settle the call, so a misbehaving observer can never turn a failed step into a completed one and
  corrupt a run's history.

  **The trace.** The watcher previously held a live root span per run and ended it on `run.suspended`,
  which fragments a durable workflow into one trace per turn — the failing step in a different trace
  from the turn that dispatched it. The trace id is now **derived from the run id**, so a run is one
  trace no matter how many times it suspends, how long it waits, or how many processes execute it — a
  worker elsewhere derives the same id from the same id. Lifecycle entries state that trace id
  explicitly, so an event emitted outside any execution scope (a remote step's result landing in a
  transport callback, a recovery sweep) is still findable from the run.

  **Nesting.** A unit reuses the open batch when _this_ Telescope wiring already has one for _this_ run
  on the current async path; anything else opens a fresh one. The consequence differs by transport and
  is worth knowing before you meet it: with an in-process transport the step handler runs inside the
  turn that dispatched it and its result resumes the next turn on the same path, so the whole run is
  one batch — it genuinely is one causal chain; with a queue-backed transport each turn and each step
  is a separate entry point in a separate process and gets its own. A child workflow is a different
  run, so it always gets its own batch and its own trace. The `traceId` is the invariant that holds
  across every shape.

  **Origin.** Batches are recorded as `origin: 'queue'`. Telescope's `BatchOrigin` is the closed union
  `'http' | 'queue' | 'schedule' | 'cli' | 'manual'` with no durable/workflow member; widening it
  belongs to that repo and a coordinated release, and `'queue'` is accurate anyway — durable work
  reaches an executor by being dispatched over a transport, exactly like the jobs the BullMQ watcher
  marks `'queue'`.

  **New: `durableTraceContext()`.** Telescope resolves an entry's trace id from an ambient OTel span,
  and `@opentelemetry/api` alone propagates nothing — without a registered context manager
  `context.with(...)` is a no-op. An app running no OTel SDK (most of them) would therefore get
  correlated batches and null trace ids. Pass `TelescopeModule.forRoot({ traceContext:
durableTraceContext() })` and entries recorded by the _other_ watchers during a turn or step pick up
  the run's trace too. An app that does run a full OTel SDK keeps `OtelTraceContextProvider` —
  optionally as `durableTraceContext(new OtelTraceContextProvider())`, which consults it first — and
  both agree, because the scope's spans already hang off the run's trace.

  **Not covered, deliberately.** A remote step (a Python handler, say) executes out of process; its
  lifecycle entries carry the run's trace id, but the queries and exceptions inside it are that
  runtime's to record. A remote workflow is likewise unwrapped: the engine dispatches a workflow task
  and awaits a decision rather than executing a body, and a scope around a dispatch would describe the
  wrong thing.

## 0.7.3

### Patch Changes

- a8f8e6d: Tell apart the two blank cells in the Workers table.

  `—` meant both "this worker's heartbeat carries no `WorkerStatus` at all" and "it reports fine, it
  just has nothing to measure yet". Those are different incidents. The first is a fleet that has
  stopped talking, or an SDK too old to; the second is the normal state of an idle deployment —
  `throughputPerMin` and `p95Ms` come off the adaptive controller's rolling window of completions, so
  they are absent until a step finishes inside it, and `lastAdjust` is absent until the controller
  actually moves the limit.

  Rendering both the same way sends a reader hunting for a broken worker that is merely idle. A
  deployment where every `py-flip-*` row showed `—` for Thrpt/min, p95 and Last adjust was exactly
  that: healthy workers, empty window.

  Now `n/a` is "not reported" and `—` is "nothing to measure yet". Mode, limit, in-flight and the
  min–max range are never measurements — a status either declares them or there is no status — so
  their absence is always `n/a`.

## 0.7.2

### Patch Changes

- ad67612: Give the Workers table the full width of its row instead of half the viewport.

  The "Workers" section declared `cols: 2` and held exactly one panel — the eleven-column worker
  table, the widest on the dashboard. A section renders as a fixed `grid-cols-N` grid, one panel per
  cell, with no `colSpan`, so that table got a 575px cell on a 1418px viewport, scrolled sideways
  inside its own card, and left the cell beside it empty. `cols: 1` gives it the whole row.

  A new spec asserts the invariant for **every** section, not just this one: a panel count that is
  not an exact multiple of `cols` leaves a visible hole beside the last row, and it now fails the
  build with the offending section named.

  The `Limit` column is gone with it: `In-flight` renders `<inFlight>/<limit>`, so a Limit column
  beside it repeated its own denominator on every row.

## 0.7.1

### Patch Changes

- 1bd5fe5: Fix: the durable Telescope watcher no longer crashes registration on a store-less thin-worker /
  tenant deployment. In that topology the `WorkflowEngine` token resolves to a start-only
  `DurableStartClient` facade (it proxies run starts over the transport and has no local lifecycle
  event stream — those events live on the operator that holds the store), so calling `engine.subscribe`
  threw `engine.subscribe is not a function` and the watcher failed to register. The watcher now skips
  registration gracefully when the resolved engine exposes no `subscribe`, leaving the rest of
  Telescope unaffected.

## 0.7.0

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

## 0.6.2

### Patch Changes

- 15437b1: Rename the Workflows dashboard "Starved worker groups" panel to "Worker health".
  The panel lists ALL worker groups (starved sorted first) with a Status column that
  flags STARVED only when a group has queued work and zero live workers — the old
  title read as if every listed group were starved.

## 0.6.1

### Patch Changes

- 7b8027d: Fix state-breakdown pie palette so each status reads with the semantically-correct color (completed=green, failed=red), aligned index-for-index with the status list.
  Deduplicate triplicated run lifecycle events (the engine emits each event on every pod) by `${event}:${runId}` before aggregating, so throughput, success rate, runs-over-time, timeseries and duration are no longer inflated ~3×.

## 0.6.0

### Minor Changes

- c1aaacd: Add a transient `cancelling` run status so a compensating cancel is visible (and durable) instead of looking like a still-`running` run.

  **core:** `RunStatus` gains a non-terminal `'cancelling'`. `cancel(runId, { compensate: true })` now persists `cancelling` immediately (and returns it) while the background saga undo runs, then flips to `cancelled` — previously the run stayed `running`/`suspended` with no outward signal that a cancel was in flight. A repeat compensating cancel is idempotent. The status is treated as in-flight everywhere it must be: the singleton admission gate counts it, and recovery re-drives it — so a crash mid-compensation re-derives the cancel intent from the persisted status and finishes the cancel (a compensating cancel is now crash-durable). A non-compensating `cancel()` is unchanged (straight to `cancelled`). For a remote/polyglot workflow (no TS-side compensations) a `cancelling` run finalizes deterministically to `cancelled`.

  **stores (mikro-orm / typeorm / prisma / drizzle):** `listIncompleteRuns()` now also returns `cancelling` runs so recovery re-drives a compensation interrupted by a crash. Columns are free strings — no migration.

  **dashboard / telescope:** render `cancelling` with a distinct in-progress amber (it pulses like a live run; distinct from the grey terminal `cancelled`), add it to the status filter and the state-breakdown chart.

  **codegen:** generated run-status union types include `'cancelling'`.

## 0.5.1

### Patch Changes

- 1d76da7: Migrate all internal consumers (engine factory, registrars, timer poller, dashboard service, telescope data providers) to the canonical capability tokens, and flip the dual-bind so the canonical token (`@dudousxd/nestjs-durable:state-store`/`:transport`/`:options`) is the real provider while the legacy `nestjs-durable:*` tokens become `useExisting` back-compat aliases. The legacy tokens are now `@deprecated` but still resolve to the same instances — fully non-breaking.

## 0.5.0

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

- f14f991: Redesign the Workflows dashboard as golden-signals sections (Health / Needs
  attention / Trends): success-rate gauge, p95 duration + distribution, backlog and
  throughput with trend, top failing workflows, stuck runs, and a state breakdown.
  Requires `@dudousxd/nestjs-telescope` with the enriched panel IR.

## 0.4.0

### Minor Changes

- 3e71141: Surface worker-health on the Telescope "Workflows" dashboard. A new `durable.workerHealth` data provider reads `WorkflowEngine.workerHealth()` (queue depth vs. live worker heartbeats), powering two new panels: a **"Starved groups"** stat (groups with work queued and zero live workers — the "alive but not consuming" alert state) and a **"Worker groups"** table (group · queued · live workers · status, starved first). Complements the `/durable` Workers panel for ops who live in Telescope.

## 0.3.0

### Minor Changes

- 613f356: Workflows dashboard "Recent failed runs" table is now time-bounded and shows when each failure happened. The `durable.recentFailures` provider only returns failures updated within a window (default 24h; `durableTelescopeExtension({ recentFailuresWindowMs })` to tune, `0` for all) and includes a compact `updatedAt` stamp per row — so a healthy system shows an empty table instead of surfacing days-old failures as if they were a live incident.

## 0.2.0

### Minor Changes

- 76e9977: Add `durableTelescopeExtension()` — a first-class Telescope extension that adds a native "Workflows" health dashboard. Register it via `TelescopeModule.forRoot({ extensions: [durableTelescopeExtension({ runHref })] })`. It bundles the existing `DurableTelescopeWatcher` plus a `durable.workflows` dashboard (success rate, failed-in-window, current-state gauges for dead/suspended/running/pending, top failing workflows, and a recent-failures table that deep-links each run out to the durable dashboard via `runHref`). Rollups come from the `durable` entries Telescope already captures; current-state gauges read the durable store live via `listRuns`. Requires a `@dudousxd/nestjs-telescope` version that supports the `extensions` option. The standalone `DurableTelescopeWatcher` export is unchanged.
