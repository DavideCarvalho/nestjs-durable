# @dudousxd/nestjs-durable-core

## 0.64.0

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

## 0.63.0

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

## 0.62.1

### Patch Changes

- b1137e3: Read cron schedules through either cron-parser major, not only v4

  `cron-parser` is declared as an optional peer at `^4.0.0 || ^5.0.0`, but `prevCronFireMs`
  only ever called v4's entry point. The two majors do not share one: v4 exports
  `parseExpression`, v5 replaced it with `CronExpressionParser.parse`. Every v5 install
  therefore failed the moment a cron schedule was evaluated:

  ```
  parser.parseExpression is not a function
  ```

  which reads as a missing dependency rather than as the wrong major — and since the
  scheduler probes cron at boot, the symptom was "no connector will run on a schedule" with
  nothing obviously wrong in the install.

  The cause was the type: `typeof import('cron-parser')` pins the module to whichever major
  is dev-installed, so the _other_ major's entry point is a compile error and can never be
  called. The module is now typed `unknown` and narrowed by runtime guards in a new
  `cron-compat.ts`, which picks v4's or v5's entry point and unwraps an ESM `default`
  namespace. Note that v4's CommonJS export is a _function_ carrying `parseExpression`, not
  an object, so the guard admits both.

  Only one major can be installed at a time, so the existing suite can never exercise both:
  `cron-compat.spec.ts` pins the entry-point selection against fake module shapes instead.
  The scheduler suite passes against 4.9.0 and 5.5.0 alike, and now throws a message naming
  the supported range if a module presents neither entry point.

## 0.62.0

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

## 0.61.0

### Minor Changes

- b7568e3: Ambient step logger — record step events from anywhere inside a handler, without threading the `StepLogger` down.

  The Python SDK has had context-local step access for a while (`current_step`, `log`, `sub`, `sub_event`, `sub_process`); TypeScript only ever handed the `StepLogger` to the step body as its second argument. A generic utility a few layers below the handler (a batch inserter, an HTTP client) therefore could not emit without every signature on the path being edited — which contradicts the library's own goal that "observability is symmetric regardless of where the step ran".

  **core** — new `ambient-step.ts`, mirroring `ambient-ctx.ts` (the `AsyncLocalStorage` lives on `globalThis` under a `Symbol.for` key, so duplicate copies of core in a dependency tree share one storage):

  - `runInStepLogger(logger, fn)` / `currentStep(): StepLogger | undefined`
  - module-level shortcuts for the logger surface: `sub(...)`, `subEvent(...)`, `subProcess(name, body, opts?)`
  - log lines in both spellings: `debug` / `info` / `warn` / `error` (one per `StepLogger` method — the idiomatic TS form, for a level known at the call site) and `log(level, message, data?)` (the literal twin of the Python SDK's `log`, for a level that is computed)

  The engine installs the ALS at every point a logger is born — the local-step path (`ctx.step` in `workflow-ctx.ts`) and the remote-worker path (`runStepHandler`, so every transport gets it) — binding the SAME instance the body already receives as its argument, never a second one. Concurrent step invocations each see their own logger.

  **worker** — the thin worker runtime binds it too, on both its step-handler path (`StepWorker.processTask`) and its local-step path (`WorkflowContext.runStepBody`).

  Outside a step everything is a no-op: `currentStep()` returns `undefined`, `log`/`sub`/`subEvent` do nothing, and `subProcess` still runs its body (and still hands it a handle) but emits nothing. That is what lets a generic utility be instrumented with no `if` at the call site and stay usable in a unit test with no durable run around it.

  Purely additive: the `StepLogger` second argument is unchanged.

### Patch Changes

- d648903: fix(core): retrying a dead-lettered run now actually resurrects it

  `requeue` reset the failure state its docstring promises to reset — the failed checkpoints, the stale
  `error` — but left the run-level `recoveryAttempts` at the cap. A run dead-lettered at
  `maxRecoveryAttempts` therefore came back `pending` and the very next `recoverIncomplete` pass
  computed `cap + 1` and dead-lettered it again within seconds: the retry was accepted, the run was
  re-killed with the same generic `max_recovery_attempts` error, and nothing progressed. Dead runs were
  effectively unrecoverable — including via the dashboard's bulk "retry every dead run matching …",
  which reported every run as applied while each was re-killed moments later.

  Resurrecting a `failed`/`dead` run now clears the counter (`recoveryAttempts: 0`), completing the
  run-level half of the reset the checkpoint loop already did. `0` rather than `undefined`, because
  adapters disagree on what an undefined patch value means (the MikroORM and TypeORM mappers skip it,
  so it would silently leave the old count in place); `0` writes a real value everywhere and reads back
  identically, since `countRecovery` uses `(recoveryAttempts ?? 0) + 1`.

  The reset is scoped to runs that had come to rest: requeueing a run still `running`/`suspended` is
  not a resurrection, and zeroing there would let a retry loop keep a genuinely crash-looping run alive
  forever. A poison pill still dead-letters after a retry spends its fresh budget. The `signal:child:`
  cascade requeues failed/dead children through the same path, so their budgets are restored too.

- 35c7fbd: fix(core): orphan recovery no longer dead-letters a run whose remote step is still in flight

  `recoverIncomplete` inferred "the run lease is acquirable" ⇒ "its worker crashed". That inference
  does not hold for a run awaiting a **dispatched remote step**: the work sits on the transport and
  nobody holds the RUN lease while a worker executes it. Every such pass incremented
  `recoveryAttempts`, so a long-running step could exhaust `maxRecoveryAttempts` and the run was moved
  to `dead` with a generic `max_recovery_attempts` error while its worker was still processing
  normally (seen in production: 10 attempts in 57 seconds, the step's job still `active` on the queue).

  `recoverIncomplete` now checks for an in-flight (`pending`) remote checkpoint before counting. When
  one exists the run is not an orphan, so instead of counting an attempt and re-dispatching, the engine
  re-asserts the state the contract already specifies for it (`StepCheckpoint.status`: `pending` = the
  run is durably suspended) — it parks the run `suspended` on the reconcile timer and hands the lease
  back. The worker's result resumes it as usual, `resumeDueTimers` remains the safety net, and the run
  drops out of the orphan sweep entirely instead of accruing recovery attempts.

  Genuine poison pills are unaffected: a run that crash-loops with no dispatched step in flight (or
  whose remote steps have all settled) still counts attempts and still dead-letters. A LOST dispatch is
  still not this pass's job — `remoteRedispatchMs` and `redispatchPending` own that, unchanged.

## 0.60.0

### Minor Changes

- f0ada3f: Make the `RunGateway` DI token idiomatic. `RunGateway` (in `-core`) is now an **abstract class** that doubles as its own NestJS injection token, so providers bind `{ provide: RunGateway, useFactory/useClass }` and consumers inject `constructor(private readonly gateway: RunGateway)` — no string/symbol token. Because `-core` is a required peer of both `nestjs-durable` and its dashboard, the single abstract class is a shared token across packages, replacing the previous duplicated `Symbol.for('nestjs-durable:run-gateway')` value-sharing hack.

  Non-breaking: the `RUN_GATEWAY` symbol export is kept as a `@deprecated` alias pointing at the `RunGateway` class, so existing `@Inject(RUN_GATEWAY)` / `{ provide: RUN_GATEWAY }` sites resolve the very same token. It will be removed in a future major.

## 0.59.0

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

## 0.58.0

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

## 0.57.0

### Minor Changes

- 0f8b6ac: **Retry of a FAILED run now re-executes its failed parts** instead of replaying deterministically
  into the same failure within milliseconds. `engine.requeue` (the dashboard's Retry button) resets
  the failure state first: exhausted `failed` checkpoints become retryable-now (attempts 0, wake
  immediately) so the durable-retry machinery re-dispatches them fresh, and an awaited-child
  `signal:child:` checkpoint holding a FAILURE completion returns to its live placeholder so replay
  re-registers the child waiter. Retry a failed parent and its failed child in EITHER order — signal
  buffering makes it converge (`ctx.child` now consumes an already-buffered child completion on
  re-registration, closing a lost-wake where a child retried to completion could never resume its
  later-retried parent).

  **Dashboard: lineage navigation.** A child run's header now has an `↑ parent` chip (back to the
  macro view) and a `~retry~` run links `↩ original` — both derived purely from the run id
  (`<parent>.child.<seq>`, `<original>~retry~<hash>`), no wire changes.

## 0.56.0

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

## 0.55.1

### Patch Changes

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

## 0.55.0

### Minor Changes

- cb7a104: A child workflow that FAILS TO START no longer hangs its parent in suspended-forever. Both deferred
  child-start paths (the in-process ctx host and the remote `startChild` command) swallowed the
  `engine.start` rejection (`.catch(() => undefined)`) — so an unregistered/unroutable child workflow
  (e.g. a misconfigured remote `processing` group), an input-validation failure, or singleton
  back-pressure left the parent silently parked on its `child:<id>` waiter, invisibly re-attempting on
  every recovery wake. The failure mode looked exactly like a healthy long wait: no error anywhere, on
  any run, ever.

  Now the start failure is delivered to that waiter exactly like a failed child (`notifyParent`
  with `{ ok: false }`): the awaited parent resumes and fails loudly with
  `child workflow "<name>" failed to start: <cause>`. For a fire-and-forget `ctx.startChild` (no
  waiter) the completion is buffered — a later join by the same id consumes it and correctly observes
  the failed start. Shared via a new `startChildDeferred` engine helper; behavior for healthy children
  is unchanged.

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

## 0.54.0

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

## 0.53.0

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

## 0.52.0

### Minor Changes

- 161c574: Cross-runtime control-flow recognition: workflow catch blocks that clean up on REAL failures had
  no reliable way to let the engine's control-flow exceptions through — `instanceof
WorkflowSuspended` fails when the workflow executes on the thin worker, whose `ctx.step`/
  `waitForSignal` suspends throw `@dudousxd/durable-worker`'s `Suspend` instead. A consumer that
  misclassified a thin-worker suspend as a failure ran its cleanup DURING the suspend, emitted
  extra checkpoints into history, and the resumed replay died with NondeterminismError.

  All three control-flow signal classes (core's `WorkflowSuspended`/`ContinueAsNew`, worker's
  `Suspend`) now carry the well-known marker `Symbol.for('aviary:durable:control-flow')`, and core
  exports `isWorkflowControlFlowSignal(error)` — the ONE predicate workflow code should use in
  catch paths: recognized signals must be rethrown untouched. `Cancelled` and `StepFailed` are
  deliberately NOT control-flow (a terminal the consumer may handle, and a real failure); the thin
  worker's `continueAsNew` throws `UnsupportedOnThinWorker`, a usage error, also excluded.

## 0.51.0

### Minor Changes

- f40d7bd: New opt-in `WorkflowHandler<TInput, TOutput, A>` interface: `implements` it on a `@Workflow` class to
  pin `run(ctx, input)`'s signature at the declaration site, so a wrong signature (renamed method,
  swapped/missing param, wrong return type) is a compile error at the class instead of a runtime
  discovery failure or a silently-wrong type flowing out of `ctx.child`/`engine.start`. Types-only —
  registration and engine behavior are unchanged. Also extends `@dudousxd/nestjs-durable`'s core facade
  re-exports with `readSearchAttributes`, `StepEvent`, `InferSearchAttributes`, `SearchAttributesSchema`,
  and `WorkflowHandler`.

## 0.50.1

### Patch Changes

- e5ae5ff: `readSearchAttributes` accepts a run whose `searchAttributes` is `null` (the nullable JSON column shape every ORM store entity exposes), not just `undefined`.

## 0.50.0

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

- 25f8000: **`RunDetail` single-sourced from core.** `RunDetail` (a run + its timeline + child ids) was
  independently re-declared three times — core's `RunGateway` port, the dashboard server's
  `DashboardService`, and the dashboard client's SPA mirror (with its own client-local `WorkflowRun`/
  `StepCheckpoint` types on top) — free to drift out of sync on any future field addition.

  Core adds `WireDates<T>`, a small mapped type that turns every `Date` (and `Date | undefined`) field
  of a server type into its ISO-string wire form, preserving each field's own optional modifier. The
  dashboard server now imports and re-exports core's `RunDetail` instead of re-declaring it (no behavior
  change — same shape, same export). The dashboard client's SPA `WorkflowRun`/`StepCheckpoint`/
  `RunDetail`/`StepEvent`/`RunWaiting` are now derived from the core types via `WireDates` (type-only
  imports; erased at build) instead of hand-mirrored field by field, so a new core field now shows up on
  the client automatically. A few fields stay deliberately client-local and are documented inline where
  they diverge (`StepCheckpoint.enqueuedAt` and `WorkflowRun.input` stay optional against core's
  required equivalents; `error` widens to the real `StepError` shape; `RunDetail.children` stays
  optional) — none of these change the client's public type surface for existing consumers.

- 25f8000: Typed, validated search attributes. `@Workflow({ searchAttributes })` takes a **Standard Schema** (https://standardschema.dev — zod 3.24+, valibot, arktype, …) whose inferred output must be search-attribute-shaped (flat `string`/`number`/`boolean` values only — enforced at the declaration site, a nested-object schema is a compile error). When declared, `ctx.upsertSearchAttributes` validates the MERGED result (existing attributes shallow-merged with the patch) before writing — an invalid merge throws, naming the workflow, the offending key(s), and the schema's issues. Validation runs once, at the same first-run-only position as the write itself, so it's skipped on replay like the write. `WorkflowCtx` is now generic (`WorkflowCtx<A extends SearchAttributes = SearchAttributes>`, defaulting to the untyped shape, fully backward compatible) — pair it with the new `InferSearchAttributes<typeof mySchema>` helper to type a workflow's `run(ctx: WorkflowCtx<...>, input)`. Core also exports a new `readSearchAttributes(schema, run)` helper for the read side: safe-parse semantics — an invalid or missing `run.searchAttributes` returns `{}` (typed) instead of throwing, since older runs may predate the schema. No schema declared ⇒ unvalidated behavior is unchanged.

## 0.49.4

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

## 0.49.3

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

## 0.49.2

### Patch Changes

- 97d43b7: Self-heal runs that suspend waiting on an EVENT (a child's completion, a signal, a remote step with no `timeoutMs`) instead of a `ctx.sleep`. Those suspends carried no `wakeAt`, so if the wake was ever LOST — the delivering pod crashed or rolled mid-handoff — the run sat `suspended` with `wakeAt: null` forever: invisible to the timer poller (no `wakeAt`) AND to crash-recovery (no lease). In a singleton workflow this deadlocked the whole per-key queue behind the orphaned leader.

  The engine now stamps a fallback `wakeAt` (new `reconcileMs` option, default 5 min; set `0` to disable) on any timer-less suspend, so `resumeDueTimers` re-drives it after the window. The re-drive is an idempotent replay guarded by existing checkpoints — a still-pending dependency simply re-suspends, a settled one advances — so it's a safe reconciliation, never a retry that can double-dispatch a step or count against `maxRecoveryAttempts`. A healthy run is still re-driven by its real event long before the fallback fires, so this only ever triggers for a genuinely-orphaned run.

## 0.49.1

### Patch Changes

- 7f3e308: Classify each worker-health group as `'workflow'` or `'step'` on `GroupHealth.kind`. Route-by-handler gives every `@Workflow` and `@Step` its own queue, so a health list mixes both — `workerHealth()` now labels each from the engine's authoritative registry (a group whose base token is a registered workflow name, or a registered remote workflow's group, is a workflow; anything else — an in-process step, a remote `handle_*` — is a step). No name heuristics, no worker/transport/Python changes: the control plane already knows. Lets a dashboard summarise the fleet in domain terms ("N workflows · M steps") instead of leaking the raw queue count. `kind` is optional and only set where a control-plane registry was available to classify.

## 0.49.0

### Minor Changes

- c27c276: The dashboard header now shows the deployment's durable **role** — "control plane" or "tenant · <partition>" — instead of a hardcoded "control plane" label (which was wrong on a tenant). `RunGateway` gains a synchronous `topology(): DurableTopology` (`{ role: 'control-plane' | 'tenant'; tenant? }`): the store-backed gateway reports `control-plane`, the `ProxyRunGateway` reports `tenant` with its partition name. Exposed via `GET /api/durable/topology` and rendered as a header badge (tenant highlighted amber). No round-trip — it's local metadata each gateway already holds.

## 0.48.0

### Minor Changes

- ccd7abc: The dashboard **Workers** panel now works on a tenant deployment. `workerHealth` moves onto the `RunGateway` port (joining the read/control verbs), so a store-less tenant proxies it over the transport instead of hitting the operator-only guard and throwing `This durable dashboard operation requires the control plane`. The `RunRequestResponder` — the tenant boundary — answers it scoped to the requester's own groups by the `<name>@<tenant>` queue convention, so a tenant only ever sees the health of ITS OWN queues, never another tenant's or the operator's bare groups. On the control plane the behaviour is unchanged (every group, unscoped). `metrics`/`getEvent`/`update`/`deliverWebhook` stay control-plane-only.

## 0.47.0

### Minor Changes

- 54dc0af: Class-first workflow API: `@Workflow` classes extending the new `DurableWorkflow` base gain `MyWorkflow.start(input)` (fire-and-forget — `engine.start` outside a workflow, a parent-linked `ctx.startChild` inside one) and `MyWorkflow.execute(input)` (run-and-await the typed output — `ctx.child` inside, start + wait-until-terminal outside), with input/output inferred from the subclass's own `run` signature. Powered by a new ambient workflow context (`AsyncLocalStorage`) the engine and the thin worker install around every body execution (`currentWorkflowCtx()`), per-class engine bindings written by the registrar at boot (`bindWorkflowClass`), and `waitForRun`'s new `until: 'terminal'` option.
- 23325d3: Saga compensation for dispatched steps — `ctx.step(ref, input, { compensate })`.

  The undo is another `@Step` (a method reference, compile-checked to accept the
  `StepUndo<TInput, TOutput>` envelope of the call it undoes — see the new `UndoOf<H>` helper — or a
  name string for a cross-runtime handler, e.g. Python). On failure (or `cancel({ compensate: true })`)
  the engine dispatches the registered undos durably in reverse order, each called with the
  compensated step's `{ input, output }`.

  The whole unwind is now checkpointed at reserved negative seqs (`-1` = first undo executed): a crash
  mid-unwind resumes where it left off instead of re-running completed undos — this also applies to
  `ctx.localStep` closures, whose in-process retry semantics are otherwise unchanged. The
  `compensate:<step>` checkpoints make the saga visible in run detail; the dashboard renders them as
  an amber Compensation section with a `compensated`/`compensating` header chip and banner, and the
  client exports `splitCompensations`/`compensationSummary`/`compensationDisplayName` for consumers
  rendering their own timelines.

- cb0ae92: `ctx.all({ mode: 'failFast' })` now cancels the surviving siblings when it throws (best-effort —
  a child mid-step observes the cancellation at its next checkpoint), instead of leaving them
  running with ignored results. `DurableWebhook.wait()` accepts `{ timeoutMs }` with the same
  durable-deadline semantics as `waitForSignal` (throws `SignalTimeoutError` past the deadline;
  deadline stamped once and stable across replays).

## 0.46.1

### Patch Changes

- 6dfe57a: Fix: a child run now inherits the namespace/partition of the run it was spawned from, instead of
  the namespace of whichever engine executes the parent. Previously, when an operator engine
  (`namespace: undefined` — the control plane that recovery-resumes runs of every namespace) executed
  a tenant-stamped parent's `ctx.child`/`ctx.gather_children` (or a remote workflow's `startChild`),
  the child was stamped `default` and dispatched to the shared/default worker pool. That let a
  tenant's child leak off its partition — e.g. a `davi-local` pipeline's `processing` child escaping
  to the dev Python workers instead of the local tenant's. The child now carries the parent run's
  namespace, so tenant isolation holds regardless of which engine drives the parent. Top-level runs
  and explicit `opts.namespace` are unaffected.

## 0.46.0

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

- 48b7616: Add operator drive mode: a `WorkflowEngine` constructed with `namespace: undefined` is an
  operator control plane — it drives/recovers/resumes runs of EVERY namespace instead of just
  its own (`runPending`, `recoverIncomplete`, `resumeDueTimers`, `resume`, and
  `completeRemoteDecision` all bypass the namespace guard), and its transport(s) are left on
  their own bare/shared prefix (no `useNamespace` call). `resolveRemoteByConvention` now routes
  a tenant's run to a tenant-suffixed worker group via the new `tenantGroup(baseGroup, tenant)`
  helper: `undefined`/`''`/`'default'` stay bare (`<workflow>`), any other tenant becomes
  `<workflow>@<tenant>`. A namespace-scoped engine (`namespace: 'x'`) behaves exactly as before.

  `retryWithInput` and dead-letter routing now inherit the original run's `namespace`, so on an
  operator a tenant's retry/dead-letter run stays that tenant's (routed to its worker group) instead
  of falling back to the bare `'default'` group.

  **Behavior change — read before upgrading a shared store.** Omitting `namespace` used to mean the
  `'default'` partition; it now means OPERATOR (drives every namespace). A single-pool deployment is
  byte-identical (the only namespace is `'default'`, and runs are still persisted as `'default'`). But
  if you share ONE state store across multiple pools, EVERY pool must set its own `namespace` — a pool
  that omits it will now drive all the other pools' runs. (Correctly-configured shared stores already
  set distinct namespaces, so they are unaffected.)

- ecce3ca: Add `StartRunMessage` interface and `dispatchStartRun`/`onStartRun` optional methods to the `Transport` interface (P4 — start-run over the protocol). A DB-less tenant worker publishes a `StartRunMessage` onto `<effectivePrefix>-start-run`; the control plane consumes it and turns it into a durable run.

  Wire the control-plane consumer end to end: `WorkflowEngine.start` accepts `opts.namespace` and stamps `namespace: opts?.namespace ?? this.namespace` on the created run, and the engine constructor registers `transport.onStartRun` (guarded by the transport capability) to turn each incoming `StartRunMessage` into `start(workflow, input, runId, { namespace: tenant, tags })` — so a start-run for `{ tenant: 't1', ... }` creates a run stamped `namespace: 't1'`.

- b7c63a5: `runRedisWorker` accepts a new `tenant` option, DISTINCT from `prefix` (the transport prefix is
  untouched — typically shared with the operator control plane). Only the worker GROUP it
  registers/heartbeats under is derived via `tenantGroup(group, tenant)`
  (`@dudousxd/nestjs-durable-core`): `undefined`, `''`, or `'default'` stays byte-identical to the
  bare `group` (production unchanged); any other tenant becomes `<group>@<tenant>`, so an
  operator's `listWorkerGroups()`/`resolveRemoteByConvention` can route that tenant's runs to this
  worker instance. `tenantGroup` is now also re-exported from `@dudousxd/nestjs-durable-core`'s
  package root (it was previously only an internal module).
- 1e9155a: Add `remoteByConvention` engine option: when enabled, an unregistered workflow is
  automatically routed to the live worker group of the same name — no `engine.remote()`
  registration boilerplate needed. The worker announcing its group IS the registration.
  Default `false`; existing behavior is unchanged. Requires a transport that implements
  `listWorkerGroups` (e.g. BullMQ).
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

## 0.45.0

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

## 0.44.1

### Patch Changes

- ae9a7f9: fix(core): close the dispatch/mark race in the remote workflow-turn decision path

  The multi-instance decision fix (0.44.0) recorded a remote turn's awaited `taskId` on the run
  _after_ calling `executor.dispatch`. In production the worker's reply round-trips the in-cluster
  broker faster than the engine's marker write commits to a remote store — most visibly for a cached
  re-drive replay that returns `completed` in under a millisecond — so the decision reached
  `completeRemoteDecision` before `awaitingDecisionTaskId` was set, failed the marker guard, and was
  dropped, leaving the run stuck `suspended` with the final decision already produced.

  The dispatch-and-suspend path is now SUSPEND-then-ENQUEUE: the engine generates the turn `taskId`,
  writes the awaited marker, and releases the run lease all BEFORE enqueuing the turn, so a decision —
  however fast — always both matches the marker and can acquire the lease. `WorkflowExecutor.dispatch`
  now takes the engine-supplied `taskId` and returns `void` (it only enqueues); `RemoteWorkflowExecutor`
  no longer generates ids. Adds a regression test that delivers the decision synchronously on dispatch.

## 0.44.0

### Minor Changes

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

## 0.43.0

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

## 0.42.0

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

## 0.41.0

### Minor Changes

- 9ced893: Add parallel remote steps: `ctx.gather_calls([...])` (Python SDK) dispatches N remote steps in parallel within ONE run — each durably checkpointed and idempotent — tagged with a shared `parallelGroup` so they render as a flat parallel fan (no child runs).

  Engine support for the `call` command:

  - **Idempotency:** before persisting + dispatching a `call`, skip when a checkpoint for `(runId, seq)` already exists (pending or terminal). A `gather_calls` fan-out re-emits its still-pending calls on every partial resume, so this prevents a re-emitted call from being double-dispatched (mirrors the `startChild` guard). The result lands independently via `completeRemoteResult`, keyed by seq, so concurrent in-flight calls never clobber each other.
  - **parallelGroup:** the `call` command now carries an optional `parallelGroup`, threaded onto the remote step's checkpoint so the dashboard groups the fan vertically (parity with the gathered `recordStep` / `startChild` tags).

  The Python `durable-worker` SDK ships separately to PyPI (tag `durable-worker-v*`), so its version bump is not changeset-managed.

## 0.40.1

### Patch Changes

- 99e78fb: Remote `startChild` / `gather_children` child-await `signal:child:` checkpoints now carry the command's `parallelGroup`. The fan group is threaded `command → signal waiter → checkpoint`: the engine stamps each child waiter with the awaiting `startChild` command's group, and the resolving `signal:child:<id>` checkpoint (written when the child notifies the parent) inherits it. Each store adapter persists a nullable `parallel_group` column on the signal-waiter row so it round-trips `put → take`. As a result the dashboard renders a cross-SDK parallel child fan-out (e.g. a Python `ctx.gather_children`) stacked vertically as one parallel group instead of a misleading horizontal `start → s1 → … → sN → end` sequential chain. Additive and backward-compatible: existing waiter rows simply have a NULL group.

## 0.40.0

### Minor Changes

- 21d5594: Add `namespace` run partitioning. An engine configured with a `namespace` stamps it on every run it
  creates and only picks up / recovers / resumes-timers-for / times-out runs in that namespace. The
  StateStore list methods (`listPendingRuns`, `listIncompleteRuns`, `listDueTimers`) and `RunQuery`
  gain an optional namespace filter. Default `'default'` — byte-identical to a single-pool deployment.
  Implemented for the MikroORM store; Drizzle/TypeORM/Prisma parity is a follow-up (they ignore the
  filter until then). Read paths (dashboard, `getRun`) are intentionally not namespace-scoped.

## 0.39.0

### Minor Changes

- e6e2fb2: Remote child runs inherit their parent's remote group/executor. When a workflow registered via `registerRemote(...)` spawns a child (a `ctx.start_child` / `gather_children`-style fan-out) of a name the host never registered, the engine now resolves that unregistered child against its nearest registered REMOTE ancestor and drives it as a remote run on the same group, reusing the SAME executor instance — so spawning an unregistered child of a remote workflow no longer requires a redundant `registerRemote(childName, ...)` call just to declare routing. An explicit `registerRemote` for the child still takes precedence (inheritance only kicks in for an unregistered child), and a genuinely unregistered run with no remote ancestor still raises the existing skew-protection "not registered" error. Resolution is recomputed per resume (never memoized into the registry, so synthesized children never leak into `latest`/`knownGroups`/`sweepTimeouts`) and only runs for unregistered runs, so registered workflows are unaffected.
- 7f7faa2: Local workflows can opt into being served via a worker group (uniform dispatch, Phase 2). `register(name, version, fn, { group, executor })` now accepts an optional `group` + `executor`: when both are given, the engine DISPATCHES that workflow's turns to the group via `executor.advance` — the same path a cross-SDK (Python) `registerRemote` body takes — instead of running `fn` inline, while RETAINING `fn` so an in-app worker on that group can fetch it by name (`engine.workflowBody(name, version)`) and replay it. This makes "one app, both roles" possible: the same process owns the engine AND consumes its own group, with recovery, durable timers, singleton admission, cancel-cascade and dead-lettering staying engine concerns identical to a remote run (a group-served local registration carries `remote`, so Phase 1's child-inherits-group resolution and `knownGroups` already cover it). It is strictly opt-in and additive: omitting `group`/`executor` keeps the inline fast path with zero dispatch round-trips and no behavior change, and passing only one of the pair throws at registration. This is the first step toward routing every run through a group with no local/remote flag (Phase 3 wires the default group + in-app worker into the NestJS module and flips the default).

## 0.38.0

### Minor Changes

- a2be405: Add `ctx.upsertSearchAttributes(attrs)` — set a run's indexed `searchAttributes` from inside the workflow, without injecting the store.

  Previously, tagging the run you're executing meant injecting the raw state-store token into a `@Workflow` and calling `store.getRun(ctx.runId)` + `store.updateRun(ctx.runId, { searchAttributes })` — awkward, and it coupled the workflow to store access. Now:

  ```ts
  // before
  @Inject(STATE_STORE) private readonly store: StateStore;
  const run = await this.store.getRun(ctx.runId);
  await this.store.updateRun(ctx.runId, {
    searchAttributes: { ...(run?.searchAttributes ?? {}), key: value },
  });

  // after — no injection at all
  await ctx.upsertSearchAttributes({ key: value });
  ```

  Shallow-merges into the run's `searchAttributes` (keys you don't pass are kept). Durable + **exactly-once**: recorded at its position on the first run and skipped on replay (one write, not one per turn), nondeterminism-guarded like every other ctx primitive — it mirrors `ctx.transaction`'s record-once semantics. On the thin `@dudousxd/durable-worker` (no store) it throws `UnsupportedOnThinWorker` — run such a workflow in-process on the engine.

## 0.37.0

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

## 0.36.0

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

## 0.35.0

### Minor Changes

- c1aaacd: Add a transient `cancelling` run status so a compensating cancel is visible (and durable) instead of looking like a still-`running` run.

  **core:** `RunStatus` gains a non-terminal `'cancelling'`. `cancel(runId, { compensate: true })` now persists `cancelling` immediately (and returns it) while the background saga undo runs, then flips to `cancelled` — previously the run stayed `running`/`suspended` with no outward signal that a cancel was in flight. A repeat compensating cancel is idempotent. The status is treated as in-flight everywhere it must be: the singleton admission gate counts it, and recovery re-drives it — so a crash mid-compensation re-derives the cancel intent from the persisted status and finishes the cancel (a compensating cancel is now crash-durable). A non-compensating `cancel()` is unchanged (straight to `cancelled`). For a remote/polyglot workflow (no TS-side compensations) a `cancelling` run finalizes deterministically to `cancelled`.

  **stores (mikro-orm / typeorm / prisma / drizzle):** `listIncompleteRuns()` now also returns `cancelling` runs so recovery re-drives a compensation interrupted by a crash. Columns are free strings — no migration.

  **dashboard / telescope:** render `cancelling` with a distinct in-progress amber (it pulses like a live run; distinct from the grey terminal `cancelled`), add it to the status filter and the state-breakdown chart.

  **codegen:** generated run-status union types include `'cancelling'`.

### Patch Changes

- a9ad704: Fix remote workflow resurrection when cancelled mid-turn. In `runRemoteExecution`, a `continue`/`suspended` decision from the executor could overwrite a `cancelled` status already written by a parent cancel cascade, causing recovery to re-drive the run forever. The fix re-reads the run from the store before calling `settleRun` and bails if the run is already cancelled/terminal — identical to the guard already present in `completeRemoteResult` for remote step results.

## 0.34.0

### Minor Changes

- 31b1389: Track A liveness-rearm: a per-run heartbeat that lets a remote workflow `advance` self-heal a dead worker without re-driving a live (slow) one.

  - **core:** new opt-in `WorkflowEngineDeps.remoteAdvanceSilenceMs`. When set, the engine wraps the remote workflow `advance` in a heartbeat-rearmed deadline keyed by `runId`: each run-scoped `Heartbeat` (a beat with no `stepId`) rearms the window, and only a genuinely-silent worker trips `RemoteWorkflowTimeout` → lease released → recovery re-drives. This closes the duplicate-side-effect hazard of a fixed `RemoteWorkflowExecutor` `timeoutMs` (which can fire mid-step on a still-working worker). Default unset = prior unbounded await — no behavior change. `Heartbeat.stepId` is now optional to carry run-scoped beats. Internally, the per-step liveness helper was generalized into a single `awaitWithLivenessDeadline` reused by both the step and workflow paths.
  - **durable-worker:** the Node workflow worker now emits a run-scoped heartbeat on the shared `<prefix>-heartbeat` channel while replaying a turn (immediate + every 5s, cleared on settle), so an engine configured with `remoteAdvanceSilenceMs` keeps a slow-but-alive worker alive instead of re-driving it.

## 0.33.0

### Minor Changes

- 256b8c3: Add `ctx.all(workflow, inputs, { mode })` — run N child workflows in parallel and wait for all results (parity with the Python `durable-worker` `gather_children`). `mode: 'waitAll'` (default) aggregates child failures into a `GatherError`; `mode: 'failFast'` rejects on the first failed child. Results are returned in input order.

  Also persist a `parallelGroup` tag on step checkpoints: a worker's `ctx.gather` / `ctx.all` tags every step/child in a parallel fan with the same group, and the engine now carries it from the `recordStep` / `startChild` command onto the checkpoint so the dashboard can render the fan as one group. Additive and optional — ordinary sequential steps are untagged and unaffected.

- 90ba165: A timed-out remote workflow `advance` now **re-drives via recovery instead of marking the run `failed`** (opt-in, default-off). When a `RemoteWorkflowExecutor` is configured with `timeoutMs` and a workflow decision is dropped (a BullMQ stall/redelivery or an engine-instance restart spanning the in-memory `taskId` waiter map), the advance rejects with `RemoteWorkflowTimeout`; the engine releases the run's lease and leaves it recoverable rather than failing it, so `recoverIncomplete` re-drives a deterministic replay that settles the run and notifies its parent. A genuine executor error still fails the run, unchanged.

  Default behavior is unchanged: with no `timeoutMs` set, the advance awaits as before. **Hazard:** a timeout firing while a worker is legitimately mid-step (not yet checkpointed) would re-drive and re-run that step → duplicate side effects, so a configured `timeoutMs` must be set generously (longer than the longest legitimate turn). A liveness/heartbeat-rearmed deadline (so only a genuinely-dead worker re-drives) is the documented follow-up.

### Patch Changes

- 054059c: Add regression tests for the `listRuns({ workflow })` filter on the run-query API.

  The store-level run-query path already supports filtering runs by their registered workflow name via `RunQuery.workflow` — it is implemented across every store adapter (in-memory, MikroORM, Prisma, TypeORM, Drizzle) and surfaced through the dashboard `GET /runs?workflow=` endpoint and `WorkflowEngine.listRuns`. This adds the previously-missing unit coverage proving the in-memory store returns only runs of the named workflow, that the filter composes with `status` (both predicates must hold), and that an unmatched name yields an empty list. No public API or behavior change.

## 0.32.1

### Patch Changes

- 1d76da7: Migrate all internal consumers (engine factory, registrars, timer poller, dashboard service, telescope data providers) to the canonical capability tokens, and flip the dual-bind so the canonical token (`@dudousxd/nestjs-durable:state-store`/`:transport`/`:options`) is the real provider while the legacy `nestjs-durable:*` tokens become `useExisting` back-compat aliases. The legacy tokens are now `@deprecated` but still resolve to the same instances — fully non-breaking.

## 0.32.0

### Minor Changes

- def217f: Add canonical, cross-lib-discoverable aliases for the durable DI tokens — `STATE_STORE_CANONICAL`, `TRANSPORT_CANONICAL`, `DURABLE_OPTIONS_CANONICAL` (`@dudousxd/nestjs-durable:state-store` / `:transport` / `:options`, identical to `capability('durable', …)`). `DurableModule` dual-binds them as `useExisting` aliases of the existing tokens, so an external library can resolve durable's store/transport/options by the canonical capability name without importing durable internals. Fully additive and non-breaking: the legacy `nestjs-durable:*` tokens are unchanged and keep working.

## 0.31.0

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

## 0.30.0

### Minor Changes

- 39812a2: Add `deleteRun` to hard-delete a run and its rows.

  New `StateStore.deleteRun(runId)` removes a run plus its checkpoints, signal waiters, and normalized search-attribute rows — implemented in the in-memory store and all four ORM adapters (mikro-orm, typeorm, prisma, drizzle), forwarded by `CodecStateStore`, and covered by the shared store conformance contract. `WorkflowEngine.deleteRun(runId)` builds on it to hard-delete a run and cascade depth-first to its whole subtree (via `getRunChildren`), returning the number of runs removed.

  Unlike `cancel` (which marks a run `cancelled` but keeps it as history), `deleteRun` REMOVES the run — it no longer appears in `getRun`/`listRuns`. Intended for purging a finished run whose data is being deleted; prefer `cancel` first for a live run.

## 0.29.1

### Patch Changes

- 6f4e59e: Fix: map every patchable field in the Prisma and Drizzle `updateRun` implementations (previously a subset of fields could be silently dropped on partial updates).

  Internal engine refactors (behavior-preserving): extract `SingletonGate` to concentrate the singleton feature, funnel run settle/suspend transitions through a single `settleRun()`, and extract a `stepCheckpoint()` factory deduping 8 hand-built literals.

## 0.29.0

### Minor Changes

- a458182: Remote (polyglot) workflows now cancel at op boundaries. `WorkflowDecision.status` gains a `cancelled` variant: when a worker bails at an op boundary because the run was cancelled mid-turn, the engine persists the steps that ran this turn and leaves the run `cancelled` — instead of clobbering it to `failed` or resurrecting it to `suspended` (which a normal turn result would do).

  Pairs with `durable-worker` (Python SDK) 0.10.0, which threads `is_cancelled` through `WorkflowContext` → each `StepContext` and auto-raises `Cancelled` at every `ctx` op boundary. A Python workflow now cancels between steps with no `if ctx.cancelled` checks in user code (mid-step interruption stays cooperative via `current_step().cancelled`). Deploy the core update together with the SDK bump: an older engine would treat a `cancelled` decision as `continue` and resurrect the run.

## 0.28.2

### Patch Changes

- 15ef219: Define the DI tokens (`STATE_STORE`, `TRANSPORT`, `DURABLE_OPTIONS`) with `Symbol.for(...)` (global
  symbol registry) instead of plain `Symbol(...)`.

  A process can hold more than one physical copy of `core` at runtime — pnpm peer-dependency
  multiplexing installs a separate virtual copy per distinct peer set, and the dual ESM/CJS build can
  be evaluated once as `import` (`index.js`) and once as `require` (`index.cjs`). Plain `Symbol()`
  mints a distinct token per copy, so `DurableModule` (which provides the tokens) and an injector in
  another package — `DashboardService` in `@dudousxd/nestjs-durable-dashboard`, or a store adapter —
  could resolve different symbol instances. Nest then can't satisfy the dependency and boot fails with
  `Nest can't resolve dependencies of the DashboardService (?, WorkflowEngine) ... Symbol(nestjs-durable:STATE_STORE) ... is available in the DurableApiModule module`.
  A registered symbol collapses every copy to one identity, mirroring the existing `CONTEXT_ACCESSOR`
  token. No API change.

## 0.28.1

### Patch Changes

- b7267da: perf: `getEvent` and `getRunChildren` use targeted store queries instead of fetching and JS-filtering every checkpoint for a run. Adds two **optional** `StateStore` methods (`getLatestCheckpointByName`, `listCheckpointsByNamePrefix`) implemented by all first-party adapters; the engine falls back to the previous `listCheckpoints` scan when a custom store omits them, so this is non-breaking. Cuts per-call rows fetched from O(N) to O(1)/O(k).

## 0.28.0

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

## 0.27.1

### Patch Changes

- a7a81c6: perf: O(N) replay and single-query TypeORM writes — batch-load checkpoints once per execution into a seq→checkpoint map (serving the completed replay prefix from memory with a store fallback for positions written after the snapshot), replacing the O(N²) per-resume `getCheckpoint` round-trips. TypeORM `updateRun` is now a single `UPDATE` and `saveCheckpoint` an `upsert`.

## 0.27.0

### Minor Changes

- 00d5dcf: Re-hydrate the originating context around a LOCAL step body (consume side). The engine gains an optional `rehydrate` hook (`<T>(carrier, fn) => T`) that wraps the in-process local step-handler invocation, passing the run's `context` carrier; the default is a passthrough, so behavior is byte-identical when unset. `DurableModule` wires it automatically when `@dudousxd/nestjs-context` is installed (an accessor is bound): it resolves nestjs-context's module-level `Context` singleton via a guarded dynamic import at module init and runs each local step inside `Context.deserialize(carrier, fn)`, so `Context.userRef()/tenantId()/traceId()` work ambiently inside a `@DurableStep` handler without the consumer wrapping anything. No handler signature change (the context is ambient via AsyncLocalStorage); `@dudousxd/nestjs-context` stays an optional peer (no hard/static import), and re-hydration is best-effort — an empty/undefined carrier just runs the handler normally.

## 0.26.0

### Minor Changes

- e00d037: Optional opaque context carrier dispatched alongside `traceparent`: `WorkflowEngine`/`DurableModule` gain a `context?: () => Record<string, unknown>` option, injected into `RemoteTask` at all dispatch sites and surfaced in the Python SDK (`StepContext.context` / `current_context()`).

## 0.25.1

### Patch Changes

- 26bab70: Keep an awaited child workflow attached to its parent after it finishes, and stop a child node-click from navigating away.

  - **core:** `getRunChildren` now discovers an awaited `ctx.child` from the persisted `signal:child:<id>` checkpoint, not only the live `child:<id>` signal waiter. The waiter is consumed the instant the child settles, so a completed parent (or completed child) used to drop out of the parent→children tree — making an inline child view vanish the moment its work finished. The checkpoint persists across completion, so the edge is now stable for finished runs too.
  - **dashboard:** clicking a child-workflow node (graph) or row (spans) now opens its step detail like any other step, instead of immediately navigating to the child run. Navigating is the dedicated `child ↗` badge's job — so you can inspect a child step (and inline-expand it) without leaving the run.

## 0.25.0

### Minor Changes

- 882dddd: Show an awaited child workflow LIVE in its parent's timeline. `ctx.child` registered the child's signal waiter and suspended but saved no checkpoint, so the parent showed nothing (and no expandable child node) until the child finished. It now writes a `running` placeholder at the child's seq (the same `signal:child:<id>` name the completion overwrites), so the dashboard renders the child node — and can inline-expand it — while it runs. The placeholder is `running` (ignored by replay history, so determinism is untouched) and is overwritten as `completed`/`failed` when the child settles.

## 0.24.0

### Minor Changes

- 4a9de4a: Live per-step observability for remote (polyglot) workflows. A Python `@workflow` runs its `ctx.step`s inline over a single turn that can last minutes, so previously the engine learned of the steps only when the turn ended — the dashboard showed "no steps yet" the whole run, and when they finally landed they had a 0ms duration and no sub-process trail.

  The worker now streams each local step's lifecycle as it happens, over a dedicated point-to-point `<prefix>-step-events` queue (a single engine instance consumes each event and checkpoints it once — no cross-pod duplicate writes):

  - **core**: `WorkflowStepEvent` + `Transport.dispatchStepEvent`/`onStepEvent`; the engine persists a `running` checkpoint when a step's body begins and resolves it to `completed`/`failed` with the step's real wall-clock window and its sub-process/log `events`. The turn's final `recordStep` command now also carries `startedAt`/`finishedAt`/`events` and `applyCommands` honors them, so the idempotent turn-end persist matches the live one (real duration, not 0ms).
  - **transport-bullmq**: implements `dispatchStepEvent`/`onStepEvent` over the `<prefix>-step-events` queue.

  Result: each handler step appears `running` the moment it starts, then `completed`/`failed` with a true duration and its p-processes shown under it — live, not all at once at the end.

## 0.23.0

### Minor Changes

- 00c4f5f: Worker-health observability: surface per-group queue backlog vs. live workers, so "a worker is alive but consuming nothing" stops being silent.

  - **transport-bullmq**: a worker stamps a TTL'd liveness heartbeat (`<prefix>-worker-heartbeat:<group>:<instance>`, refreshed every 10s / 35s TTL) while it's consuming — the key expiring is the signal it died or stalled. Mirrors the Python SDK's heartbeat key, so a mixed-language group reports all its workers together. Adds `groupHealth(group)` (queue depth via `getJobCounts` + live workers via a non-blocking `SCAN`) and `listWorkerGroups()` (discovers groups from the heartbeat keyspace).
  - **core**: `WorkerHeartbeat`/`GroupHealth` types + an optional `Transport.groupHealth`/`listWorkerGroups`. `WorkflowEngine.workerHealth()` aggregates health across the engine's registered groups (so a registered group with backlog and ZERO workers still reports — the alert case) UNION the groups discovered from live heartbeats (so a local-step group surfaces once its workers beat).
  - **dashboard**: a `/workers` API endpoint + a header "Workers" panel — one chip per group showing live-worker count and backlog, turning red on `depth > 0 && liveWorkers === 0`. The Prometheus `/metrics` scrape also emits `durable_group_queue_depth` and `durable_group_live_workers` gauges, so the same signal can drive an alert rule.

## 0.22.1

### Patch Changes

- 74bd7f2: Record local steps that ran on the same turn a remote (polyglot) workflow terminates. The engine only applied a decision's `recordStep` commands on the `continue`/suspend branch — so a workflow that runs straight to completion (or failure) in a single turn, every step inline and never suspending (e.g. a Python `@workflow` whose body is a sequence of `ctx.step` calls), had all its step checkpoints silently dropped. The run showed `completed` with output but **zero recorded steps**, and a parent that awaited it via `ctx.child` then had nothing to expand inline. The `completed` and `failed` branches now apply the final turn's commands before marking the run terminal, so single-turn workflows persist their steps (including the failed one).

## 0.22.0

### Minor Changes

- 8b307f8: feat(step-logger): ergonomic `log.subProcess(name, body)` for auto-timed sub-processes

  The TS `StepLogger` now has the twin of the Python SDK's `sub_process`: wrap a phase in
  `await log.subProcess('export-file', () => upload())` and it records a terminal `ok` with the
  measured `durationMs` on success — or `failed` (with the error message) on throw, then re-throws. The
  handle exposes `sp.phase(label)` and `sp.skip(reason)`, and logs emitted inside the body are tagged
  to the sub-process so the dashboard groups them under it. Returns whatever the body returns. Replaces
  the manual `Date.now()` + `log.sub(name, 'ok', …, { durationMs })` pattern.

## 0.21.0

### Minor Changes

- 7f7598b: feat(engine): execute remote workflow `waitSignal` and `startChild` commands

  The coordinator-driven (polyglot) engine now drives the last two workflow commands a remote worker
  can emit. `ctx.wait_signal(name)` registers a signal waiter (resolved by `engine.signal(name, …)`,
  with a buffered-before-wait signal re-driven safely after the turn suspends), and
  `ctx.start_child(workflow, input)` starts a child run under a deterministic id and awaits it via the
  existing parent-notify rendezvous — a failed child surfaces as a catchable `StepFailed` in the
  parent's replay. Previously both threw "not supported yet". `call` / `recordStep` / `sleep` are
  unchanged.

## 0.20.0

### Minor Changes

- dcc97fd: Make in-flight local steps visible. A local `ctx.step` now announces its body has started — emitting a `step.started` lifecycle event and (by default) persisting a `running` checkpoint — so a long-running step shows up in the dashboard the moment it begins, not only once it completes. Previously a local step was checkpointed only on completion, so an in-progress step was invisible.

  - New checkpoint status `'running'` for a local step whose body is executing in-process. It's a placeholder overwritten by `completed`/`failed`, and never short-circuits replay (only `completed` does), so a crash mid-body simply re-runs the step.
  - New engine option `trackStepStart` (default `true`). The `step.started` event always fires (the live SSE view sees the start regardless); the flag gates only the extra `running` checkpoint write. Set it to `false` on hot paths with many short local steps to halve their checkpoint writes — at the cost of reload-survivable in-flight visibility.

- 63b0d09: Extensible sub-process model: `StepEvent` gains optional `subId` (run identity), `group`, and `phase`
  fields, and `StepLogger` gains `subEvent()` for emitting per-sub-process phase transitions and a
  terminal outcome. The dashboard renders each sub-process as an expandable lifecycle row (phases,
  duration, status, error, owned logs) grouped by run identity. The existing `sub(name, status)` is
  unchanged.

## 0.19.0

### Minor Changes

- ed4a429: Add the polyglot-workflow protocol types: `WorkflowTask`, `HistoryEvent`, `WorkflowCommand`,
  `WorkflowDecision`, and the `WorkflowExecutor` interface. These define the coordinator-driven contract
  by which a workflow authored in another SDK (e.g. the Python `durable-worker`) is advanced by the
  engine one turn at a time — the engine stays the sole owner of the durable state and applies the
  decisions a remote worker's replay produces. Types only in this release (no behaviour change); the
  engine-side remote executor lands next. See docs/plans/2026-06-15-polyglot-workflows-protocol.md.
- 38f1cc6: Drive remote (cross-SDK) workflows: `engine.registerRemote(name, version, { group, executor })`. The
  engine advances such a run by handing its history to the `WorkflowExecutor` (which dispatches a
  `WorkflowTask` to a worker — e.g. the Python `durable-worker`) and applying the returned
  `WorkflowDecision`: it persists recorded local steps, dispatches `call` commands as remote steps, and
  schedules `sleep` timers, then settles or suspends the run. Everything around it — lease, recovery,
  timers, the resume on a step result — is the same machinery as an in-process workflow, so the worker
  never touches the store. `waitSignal`/`startChild` commands are a follow-up (they fail loudly for now).
- 419facb: Carry remote workflows over the transport: `Transport.dispatchWorkflowTask` / `onDecision` (optional),
  implemented by `BullMQTransport` (dispatch a WorkflowTask on `<prefix>-tasks-<group>`, consume decisions
  on `<prefix>-decisions` — the queues the Python `durable-worker`'s `run_redis_workflow_worker` serves).
  New `RemoteWorkflowExecutor` implements `WorkflowExecutor` over a transport (correlates each turn's
  decision by `taskId`), so `engine.registerRemote(name, version, { group, executor })` drives a workflow
  authored in another SDK over Redis/BullMQ. Verified end-to-end live: a Python `WorkflowWorker` replays
  and the TS engine drives it across real Redis.

## 0.18.0

### Minor Changes

- 56eea68: Close the transport on graceful shutdown, not just drain the engine.

  `WorkflowRegistrar.onApplicationShutdown` drained in-flight runs but left the transport open, so a
  deploy left the broker workers consuming and connections to time out. It now closes the transport(s)
  _after_ the drain (so in-flight runs can still dispatch/await their remote steps while draining). Adds
  an optional `close?()` to the `Transport` interface — a no-op for in-process transports; the BullMQ
  transport already implemented it. Remember this only fires if the app calls `app.enableShutdownHooks()`.

## 0.17.1

### Patch Changes

- 2183174: Internal: extract the durable-entity and event-accumulator subsystems out of the engine.

  Carves the `__entity` runner (now `Entities`) and the `__evt_debounce`/`__evt_batch` accumulators (now `EventAccumulators`) into their own modules, leaving the engine methods as thin delegations. Adds a canonical `engine.getRunChildren(runId)` and uses it for both the cancel cascade and the dashboard run-tree, replacing the child-discovery logic that was copy-pasted across the two. Behavior-preserving — no public API change.

## 0.17.0

### Minor Changes

- e149ec6: Live step progress + per-sub-process log grouping, and a dashboard layout fix.

  - **`step.progress` events**: a running step's log lines / sub-process outcomes are now emitted as
    `step.progress` engine events as they happen (not only batched onto `step.completed`). They ride
    the control plane like any lifecycle event, so the dashboard tails a long step line-by-line. The
    dashboard merges each one into the cached run instead of refetching (no store round-trip per line —
    and the store only has the events at completion anyway). `EngineEvent` gains an optional `event`.
  - **`StepEvent.process`**: a log line emitted inside a sub-process can carry that sub-process's name,
    so the step detail panel groups a fan-out step's trail per sub-process instead of one flat list.
  - **Dashboard layout**: the run-detail spans panel no longer collapses the WorkflowGraph to 0px. Its
    height now lives in the grid track (`1fr clamp(...)`); as an `auto` row it sized to the (tall) span
    content's min-content and stole the whole grid.

  The Python worker client (`durable-worker`) gains the matching `StepContext.process(name)`, an
  `on_event` sink on `process_task`/`aprocess_task`, and live `step.progress` publishing from the Redis
  runner — released separately on its own version.

- a0adc71: Dashboard polish: fix-and-replay, run tree, more metrics.

  - **Fix-and-replay**: `engine.retryWithInput(runId, input)` re-runs a dead/failed run with a corrected input as a fresh linked run (the original stays inspectable). The dashboard run detail gets a **"Fix & replay"** button (edit the input JSON, re-run) for dead/failed runs.
  - **Run tree**: the run detail now lists the run's **children** (`ctx.child` / `ctx.startChild`), clickable to navigate the parent→children tree.
  - **Metrics**: `/metrics` adds a `durable_running_runs` gauge (alongside the `durable_pending_runs` backlog + `durable_dead_runs` DLQ-size gauges).

## 0.16.0

### Minor Changes

- dc5e0f6: Exactly-once transactional steps — `ctx.transaction(name, (tx) => ...)`.

  Runs your DB work and the step's checkpoint in **one** store transaction, so the business write and the "done" marker commit atomically — a crash can never leave the write done-but-not-checkpointed (which a plain `ctx.step` re-runs on recovery). `tx` is the store-native transaction handle (a TypeORM/MikroORM `EntityManager`, a Prisma tx client, or a Drizzle tx); do your writes on it. Needs a SQL store (all bundled SQL adapters implement the new optional `StateStore.transaction`); errors on a store without it. This is the DBOS-style exactly-once guarantee for same-database work.

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

## 0.15.0

### Minor Changes

- 36eb9d7: Crash recovery now **re-enqueues** orphaned runs instead of resuming them inline. Previously `recoverIncomplete()` (run on worker boot and every poll tick) resumed each crashed run synchronously — so a worker booting while a run had a long inline `ctx.step` (e.g. a big export rebuilt from scratch) would block on that step and never become ready (a deploy could time out). Now recovery counts the attempt (still dead-letters a poison pill past `maxRecoveryAttempts`), then sets the run `pending` and dispatches it — a worker re-runs it asynchronously, replaying its checkpoints. Boot and poll ticks return immediately. `recoverIncomplete()` now returns the runs as `{ status: 'pending' }`.

## 0.14.0

### Minor Changes

- c99508d: Self-healing recovery + non-blocking dashboard actions.

  - **Lease renewal**: while a run executes, the engine renews its recovery lease (every `leaseMs/2`), so a live worker keeps a long run while a **crashed** worker's lease still expires. `execute` now holds the lease for the whole run on every entry path (sweep, signal, remote result, dashboard), so a run is never double-executed. New `StateStore.renewRunLock(runId, owner, leaseUntilMs)` — **custom stores must add it**.
  - **Periodic orphan recovery**: the NestJS `TimerPoller` now calls `engine.recoverIncomplete()` each tick, so a run orphaned by a crashed worker self-heals within ~`leaseMs` instead of only on the next boot.
  - **Non-blocking control actions** (fixes the `/durable` retry/cancel request hanging): `retry` now re-enqueues via the new `engine.requeue(runId)` (sets `pending` + dispatches) and `cancel({ compensate })` runs the undo in the background — neither replays the workflow inline in the HTTP request anymore. A worker does the work.

## 0.13.0

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

## 0.12.0

### Minor Changes

- f2260da: feat: named events — ctx.waitForEvent + engine.publishEvent

  Name-based pub/sub on top of the signal machinery, for choreography beyond point-to-point signals. A
  run suspends on `ctx.waitForEvent('payment.settled', { match: { orderId }, timeoutMs })` and resumes
  with the payload; `engine.publishEvent(name, payload)` (also `WorkflowService.publishEvent`) fans out
  to every waiting run whose `match` the payload satisfies, returning how many it resumed. The match is
  encoded in the waiter token, so the only store change is a new `listSignalWaiters(prefix)` method
  (implemented across in-memory, TypeORM, MikroORM, Prisma, Drizzle) — no new schema.

## 0.11.0

### Minor Changes

- c3398be: feat: executionTimeout — cap a run's wall-clock lifetime

  `@Workflow({ executionTimeout: '2h' })` (or ms) moves a run to `cancelled` (`execution_timeout`) once
  it outlives the budget — a backstop for runs that get stuck or loop forever. Enforced by a new
  `engine.sweepTimeouts(now)` the timer poller calls each tick (over the existing workflow+status query;
  no new schema). The terminal `cancelled` state means a late step result can't resurrect it.

- 8b87a16: feat(scheduler): pause + overlap policy

  `ScheduledWorkflow` gains two controls:

  - **`paused`** — temporarily stop firing a schedule (kept registered).
  - **`overlap: 'skip'`** (fixed-interval) — skip a window while the previous window's run is still
    `running`/`suspended`, so a slow run can't pile up overlapping executions (default `'allow'`).

  Also adds a public `engine.getRun(runId)` pass-through.

## 0.10.0

### Minor Changes

- 12c91ff: feat: Prometheus metrics

  `collectMetrics(engine)` subscribes to the engine's lifecycle events and accumulates dependency-free
  counters — runs + steps by outcome, per-workflow run counts, step-duration sum/count. Call
  `.prometheus()` for the text exposition or `.snapshot()` for raw numbers. The dashboard wires it
  automatically and serves it at `GET <apiBasePath>/metrics` for a scrape.

- 4fb5f90: feat: CodecStateStore — encrypt / compress / redact payloads at rest

  A `StateStore` decorator that runs run/step **payloads** (input + output) through a `PayloadCodec`
  (encode on write, decode on read), so they're never stored in the clear — for at-rest encryption,
  compression, or PII redaction. Adapter-agnostic (`new CodecStateStore(innerStore, codec)`).
  Searchable metadata (id, status, workflow, tags, timestamps) and the structured `error` are left
  untouched so the dashboard, queries, and recovery keep working.

- bc4539d: feat: singleton — serialize runs by key (durable FIFO mutex)

  `@Workflow({ singleton: { key: (input) => `base:${input.baseId}` } })` runs at most one run per key
  at a time (e.g. one pipeline per base). Same-key runs queue — suspended, admitted in creation order
  as slots free — instead of running concurrently. `limit` (default 1) raises the concurrency. Race-free
  and FIFO on a consistent store: admission is the same `(createdAt, id)` view for every engine instance,
  implemented over the existing tag+status query (no new schema). Also exposed as
  `engine.register(name, version, fn, { singleton })`.

- b72c20f: feat: ctx.sleepUntil + ctx.continueAsNew

  - **`ctx.sleepUntil(date | epochMs)`** — durable sleep to an absolute deadline (e.g. "resume at
    midnight"), the absolute-time counterpart of `ctx.sleep(duration)`. Replay-stable.
  - **`ctx.continueAsNew(input?)`** — end the current run and hand off to a fresh execution of the same
    workflow with a clean history, for long-running / looping workflows that would otherwise accumulate
    unbounded checkpoints. The next run gets id `<runId>~N`; the handoff is idempotent by that id.

## 0.9.0

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

## 0.8.1

### Patch Changes

- 6979d60: fix: list runs newest-first

  `store.listRuns` now orders by `createdAt DESC` (was `ASC`) across every adapter (in-memory,
  TypeORM, MikroORM, Prisma, Drizzle), so the dashboard shows the most recent run on top instead of
  buried at the bottom.

## 0.8.0

### Minor Changes

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

## 0.7.0

### Minor Changes

- e9799ca: feat: dead-letter handler — `engine.onDead` + `deadLetterWorkflow`

  Dead-lettering is no longer only "park the run in `dead`". `engine.onDead((run) => …)` fires when a
  run is moved to `dead` (exceeded `maxRecoveryAttempts`), so a DLQ handler can alert, push to a real
  queue, or compensate. The NestJS module adds a `deadLetterWorkflow` option that routes a dead run to
  a designated workflow with `{ deadRunId, workflow, input, error }` (idempotent by a `dlq:<runId>` id).
  Omitting both keeps the prior behaviour (the run stays parked, inspectable + retriable).

## 0.6.0

### Minor Changes

- 0900830: feat: compensating cancellation — `engine.cancel(runId, { compensate: true })`

  Cancelling a run can now undo its saga first: the suspended run is resumed with a cancellation
  pending, so replay re-registers the saga and its completed steps' compensations run in reverse
  (visible as `compensate:<step>` events) before the run is marked cancelled. Plain `cancel()` is
  unchanged (immediate, no undo). The dashboard's cancel accepts `?compensate=true`
  (`durableClient.cancel(id, { compensate: true })`), and the codegen client exposes the flag.

- df6524f: feat: cron + timezone schedules

  `ScheduledWorkflow` now accepts a `cron` expression with an IANA `timezone` (DST-aware) as an
  alternative to the fixed-interval `everyMs`. The run id is keyed on the most recent fire time, so
  polling repeatedly within an interval — or racing instances on the same tick — starts each fire
  exactly once (idempotent). The NestJS module gains a `schedules` option; the timer poller fires them
  each tick on **worker** instances only. Cron evaluation uses the optional `cron-parser` peer
  dependency, so the core stays dependency-free for users who don't schedule by cron.

- 9f9767e: feat: `ctx.patched(id)` — guard in-place workflow changes

  Migrate a workflow without registering a new version: wrap the changed code in
  `if (await ctx.patched('my-change')) { …new… } else { …old… }`. A fresh run records a `patch:<id>`
  marker and takes the new branch; a run already recorded under the old code keeps the old branch,
  because the marker is **position-transparent** for it (it rolls the logical position back when the
  recorded history has a real step where the marker would sit) — so guarding code never shifts an
  in-flight run's checkpoints and can't corrupt replay. Remove the guard once old runs have drained.

- 3f79533: feat: dead-letter queue — `maxRecoveryAttempts` + `dead` run status

  Crash recovery now counts attempts per run (`WorkflowRun.recoveryAttempts`); once a still-`running`
  run exceeds the engine/module `maxRecoveryAttempts`, it's moved to the new terminal **`dead`** status
  instead of being retried forever — so a poison pill that crashes the process every boot becomes an
  inspectable dead-letter entry, not a crash loop. The new column is persisted by all four store
  adapters (TypeORM auto-schema self-heals it; Prisma/Drizzle/MikroORM schemas updated), and `dead` is
  added to the dashboard/codegen status unions. Omit `maxRecoveryAttempts` for the prior unlimited-retry behaviour.

- fb8a12b: feat: retry with backoff on the durable remote path

  A durable `ctx.call` (no `timeoutMs`) now re-dispatches a **failed** remote step up to `retries`,
  spacing attempts by the configured `backoff`/`backoffMs` — the retry deadline is stamped on the
  failed checkpoint as `wakeAt` (clock-space, persisted), so it's stable across replays and survives a
  crash. A worker can opt out per-failure by throwing an error with `retryable: false` (now carried
  through the wire by the step runner, alongside `code`), which the engine treats as a final verdict.

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

- f915e2c: feat: synchronous queries & validated updates

  Two Temporal-style primitives adapted to the suspend/checkpoint model:

  - **Query** — `ctx.setEvent(key, value)` publishes a named, replay-safe value; `engine.getEvent(runId, key)`
    reads the latest value of a live (or finished) run with no side effect. Exposed as
    `GET runs/:id/events/:key`.
  - **Update** — `ctx.onUpdate(name)` is a run-scoped update point; `engine.update(runId, name, arg)`
    delivers to it, gated by a validator registered with `engine.registerUpdateValidator(workflow, name, fn)`
    that can **reject before the run is touched** (`{ accepted: false, reason }`). Exposed as
    `POST runs/:id/updates/:name`. The codegen extension emits both routes into the typed client.

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

## 0.5.0

### Minor Changes

- **Transport control plane** — a broadcast pub/sub across all engine instances, unlocking the cross-pod features from the durability audit:

  - `Transport.publishControl(msg)` / `onControl(handler)` + a `ControlMessage` type. In-process transports (in-memory, event-emitter) broadcast locally; **BullMQ broadcasts over Redis pub/sub**. Optional — the engine degrades to local-only when a transport doesn't implement it.
  - **Cross-pod live-tail**: the engine now broadcasts lifecycle events, so a dashboard-only pod (`worker: false`) sees events from a run executing on a worker pod. The dashboard exposes `@Sse('runs/:id/stream')` and `durableClient.streamRun(id, onEvent)` — live updates without polling.
  - **Cooperative cancellation**: `engine.cancel(runId)` broadcasts the cancel; `engine.onCancel(fn)` lets a worker bridge abort in-flight work instead of finishing it just to have the result discarded. Events are deduped by originating `instanceId` so a broker echo doesn't double-deliver.

## 0.4.0

### Minor Changes

- Durability hardening (audit follow-up):
  - **Non-determinism detection**: on resume, a step whose name no longer matches the checkpoint recorded at that logical position throws `NonDeterminismError` instead of silently replaying the wrong checkpoint into the wrong step (the classic way a changed-under-flight workflow corrupts a run).
  - **Deterministic sources**: `ctx.now()`, `ctx.random()`, `ctx.uuid()` — checkpointed once and replayed verbatim, so workflows stop being corrupted by raw `Date.now()`/`Math.random()`/`randomUUID()`.
  - **Retry backoff**: `StepOptions` `backoff: 'fixed' | 'exp'` + `backoffMs`/`backoffMaxMs`/`jitter` is now actually applied between local-step retries (it was declared but ignored).
  - **Cancellation safety**: a cancelled/completed run is no longer re-executed by a late worker result or a duplicate `resume()`.
  - **testing**: `assertReplayable(register, history)` replays a recorded run's history against the current workflow code and throws on divergence — a CI guard that catches non-determinism before deploy.
  - **otel**: failed steps now emit a span (with error status), not just completed ones.

## 0.3.1

### Patch Changes

- Hardening from review:
  - TypeORM auto-schema now reads the live columns (`information_schema` / `PRAGMA`) and adds only the missing ones, instead of ALTER-and-swallow — a real ALTER failure now surfaces rather than being hidden as a presumed "column already exists".
  - Breakpoint detection keys off the checkpoint's `breakpoint` name (the explicit marker) rather than the incidentally-reused `signal` kind, so `engine.continue` can't be confused by other pending steps.

## 0.3.0

### Minor Changes

- Step-level observability + breakpoints, as a first-class transport-agnostic, cross-language capability.

  - **Step events**: a step records structured `StepEvent`s — debug/info/warn/error log lines and per-sub-process outcomes (`ok`/`failed`/`skipped`). Local steps get a `StepLogger` (`ctx.step(name, (log) => …)`); remote workers attach the same `StepEvent[]` to their `StepResult` (the Python SDK's `StepContext` is the cross-language twin), so a step that fans out internally — e.g. N parallel p-processes — shows which succeeded, failed, or weren't validated, even when the step itself completes. Events are checkpointed (`StepCheckpoint.events`) and rendered under the step in the dashboard, with at-a-glance sub-process counts on the graph node.
  - **Breakpoints**: `ctx.breakpoint(label?)` pauses a run at a point (a visible `pending` checkpoint, zero compute) until it's resumed from the dashboard's **Continue** button or `engine.continue(runId)`. Gate it on your own config to make breakpoints opt-in per run.
  - **Stores**: added the `events` column to all four adapters. The TypeORM auto-schema is now self-healing — it back-fills additive nullable columns (`input`, `events`, `enqueuedAt`, …) on a table that predates them, so an existing deployment upgrades without a manual migration.

## 0.2.0

### Minor Changes

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
