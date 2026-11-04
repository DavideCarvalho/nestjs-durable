# @dudousxd/nestjs-durable-otel

## 0.5.0

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
