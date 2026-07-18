import type { ConcurrencyOption } from '@dudousxd/durable-worker';
import {
  type AdmissionBackend,
  type ControlPlane,
  DURABLE_OPTIONS,
  DURABLE_OPTIONS_CANONICAL,
  type NamedTransport,
  type QueueConfig,
  type RetentionPolicy,
  RunGateway,
  STATE_STORE,
  STATE_STORE_CANONICAL,
  type ScheduledWorkflow,
  type StateStore,
  TRANSPORT,
  TRANSPORT_CANONICAL,
  type Transport,
  WorkflowEngine,
  type WorkflowRef,
} from '@dudousxd/nestjs-durable-core';
import {
  type DynamicModule,
  Inject,
  Injectable,
  type InjectionToken,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule, ModuleRef } from '@nestjs/core';
import type { ContextAccessor } from './context-accessor';
import { DurableStartClient } from './durable-start-client';
import { DurableStepRegistrar } from './durable-step.registrar';
import { thinWorkerProviders, unavailableRunGateway } from './durable-worker.module';
import { EntityService } from './entity';
import { inAppWorkerProviders } from './in-app-worker';
import { ProxyRunGateway } from './proxy-run-gateway';
import { RetentionPoller } from './retention-poller';
import { isDrivingOperator } from './role';
import { RunRequestResponder, type RunRequestTransport } from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';
import { TenantEventRepublisher } from './tenant-event-republisher';
import { TimerPoller } from './timer-poller';
import { CONTEXT_ACCESSOR } from './tokens';
import { WorkflowRegistrar } from './workflow.registrar';
import { WorkflowService } from './workflow.service';

/**
 * Locate the context accessor non-strictly: an accessor provided by ANY module (a global
 * `ContextModule` from `@dudousxd/nestjs-context`, or the app root) is found via {@link ModuleRef},
 * because DurableModule is `global` and its engine factory can't see another module's local
 * providers directly. Returns undefined when the optional peer isn't installed/bound.
 */
function resolveAccessor(moduleRef: ModuleRef): ContextAccessor | undefined {
  try {
    return moduleRef.get<ContextAccessor>(CONTEXT_ACCESSOR, { strict: false });
  } catch {
    return undefined;
  }
}

/**
 * Build an opaque context carrier from a {@link ContextAccessor} — the auto-feed default for the
 * engine's `context` option when `@dudousxd/nestjs-context` is present and the app passed no own
 * reader. Drops fields the accessor doesn't populate, so an empty/anonymous request yields `{}`.
 */
function carrierFromAccessor(accessor: ContextAccessor): Record<string, unknown> | undefined {
  const carrier: Record<string, unknown> = {};
  const traceId = accessor.traceId();
  if (traceId !== undefined) carrier.traceId = traceId;
  const tenantId = accessor.tenantId();
  if (tenantId !== undefined) carrier.tenantId = tenantId;
  const userRef = accessor.userRef();
  if (userRef !== undefined) carrier.userRef = userRef;
  return carrier;
}

/**
 * The slice of `@dudousxd/nestjs-context`'s module-level `Context` singleton we use to re-hydrate the
 * originating context around a local step body. Structural — we never import the package's types (it
 * is an OPTIONAL peer); the guarded dynamic import below captures whatever the installed package
 * exports as `Context`.
 */
interface ContextRuntime {
  /** Re-hydrate a context from an opaque carrier and run `fn` inside its ALS scope. */
  deserialize<T>(carrier: Record<string, unknown>, fn: () => T): T;
}

function isContextRuntime(x: unknown): x is ContextRuntime {
  return !!x && typeof (x as ContextRuntime).deserialize === 'function';
}

/**
 * Resolve `@dudousxd/nestjs-context`'s runtime `Context` singleton via a GUARDED dynamic import — used
 * to build the engine's `rehydrate` bridge. The runtime `Context` (its `deserialize`/ALS `run`) is a
 * module-level singleton, NOT a DI provider behind {@link CONTEXT_ACCESSOR}, so it can't be resolved
 * through ModuleRef — we import it directly. We do NOT add a hard/static import (the peer is optional):
 * a failure (peer not installed) returns undefined and the engine falls back to passthrough re-hydration.
 */
async function resolveContextRuntime(): Promise<ContextRuntime | undefined> {
  try {
    // Indirect the specifier through a variable so the compiler does not try to STATICALLY resolve
    // the optional peer (it may be uninstalled). This stays a runtime guarded import — a missing
    // module rejects and is caught below.
    const specifier = '@dudousxd/nestjs-context';
    const mod = (await import(specifier)) as { Context?: unknown };
    return isContextRuntime(mod.Context) ? mod.Context : undefined;
  } catch {
    return undefined;
  }
}

/** True when `x` can act as a control plane (broadcast pub/sub) — e.g. a broadcast-capable transport. */
function isControlPlane(x: unknown): x is ControlPlane {
  return (
    !!x &&
    typeof (x as ControlPlane).publishControl === 'function' &&
    typeof (x as ControlPlane).onControl === 'function'
  );
}

/** A store that can derive a tenant-namespace-scoped view of itself (the MikroORM adapter). */
interface ScopeableStore {
  /** Derive a store confined to `scope.namespace`, sharing the same backing connection. */
  withScope(scope: { namespace?: string }): StateStore;
}

/**
 * True when `store` can produce a namespace-scoped view of itself. Structural check (same idiom as
 * {@link isControlPlane}) so the store-agnostic module never imports a concrete adapter — the
 * pre-built `store` is only re-scoped when it actually carries the capability.
 */
function isScopeableStore(store: StateStore): store is StateStore & ScopeableStore {
  return typeof (store as StateStore & Partial<ScopeableStore>).withScope === 'function';
}

/**
 * Apply opt-in tenant read scoping to a pre-built store. The module receives `store` already
 * instantiated (it is store-agnostic — no MikroORM import), so it cannot reconstruct it; instead it
 * asks the store for a scoped view via the optional {@link ScopeableStore.withScope} capability. When
 * `scopeReads` is off, `namespace` is unset, or the store can't scope itself, the original store is
 * returned unchanged (the operator view) — the caller can always pass an already-scoped store.
 */
function scopedStore(store: StateStore, options: DurableModuleOptions): StateStore {
  if (options.scopeReads !== true || options.namespace === undefined) return store;
  if (!isScopeableStore(store)) return store;
  return store.withScope({ namespace: options.namespace });
}

/**
 * Retention config for the {@link RetentionPoller}. One or more {@link RetentionPolicy policies}
 * (status sets must be disjoint — validated at boot), swept together on a shared interval.
 *
 * ```ts
 * retention: {
 *   sweepInterval: '1m',
 *   batchSize: 1_000,
 *   policies: [
 *     { statuses: ['completed', 'cancelled'], maxAge: '14d', maxCount: 200 },
 *     { statuses: ['failed'], maxAge: '90d' }, // keep failures longer for debugging
 *   ],
 * }
 * ```
 */
export interface DurableRetentionOptions {
  /** The retention rules, one per (disjoint) status group. */
  policies: RetentionPolicy[];
  /**
   * How often to run the prune sweep. A number is milliseconds; a string is an `ms`-style duration
   * (`'1m'`, `'5m'` — `'m'` is minutes). `0` runs it once on boot only. Defaults to 60000 (1 minute).
   */
  sweepInterval?: number | string;
  /** Max runs hard-deleted per batch (per policy, looped until drained). Defaults to 1000. */
  batchSize?: number;
}

/**
 * Options for `DurableModule.forRoot`/`forRootAsync`. The **role is inferred** from which of `store`/
 * `connection` are set:
 *
 * - `{ store, transport }` — **operator**: a real `WorkflowEngine` + `StoreRunGateway` + drivers/
 *   timer/retention/registrars, executing registered bodies INLINE. Driven by {@link drive} (default
 *   `true`).
 * - `{ connection }` (no `store`) — **thin worker**: `WorkflowEngine` resolves to a store-less
 *   `DurableStartClient`; `RUN_GATEWAY` is a `ProxyRunGateway` when `transport` is also given, else
 *   every method rejects with a clear error. No store/timer/retention/entity — just discovered
 *   `@Workflow`/`@Step` handlers served over ONE `runRedisWorker` consumer.
 * - `{ store, transport, connection }` — an **operator that also runs a co-located worker**: every
 *   `@Workflow` is registered GROUP-SERVED (dispatched over the transport, PER WORKFLOW NAME, instead
 *   of inline) and a co-located consumer (one `runRedisWorker` call) replays the same bodies.
 *
 * `forRoot` throws when neither `store` nor `connection` is set, and when `store` is set without a
 * `transport`.
 *
 * Set {@link DurableModuleOptions.topology} to name the role explicitly instead of relying on this
 * inference — it additionally VALIDATES the axes above (`namespace` vs `partition`) that this prose
 * is otherwise the only source of truth for. Omitting it changes nothing.
 */
export interface DurableModuleOptions {
  /** State store — set this to play the **operator** role (see the interface doc for the full role
   *  matrix). Omit for a store-less **thin worker** (`connection` only). */
  store?: StateStore;
  transport?: Transport;
  /**
   * An ordered pool of named transports for failover / multi-broker setups. The engine dispatches on
   * the first and fails over to the next; a step pins one via `ctx.step(handler, input, { transport })`.
   * Use instead of `transport`.
   */
  transports?: NamedTransport[];
  /**
   * Cross-instance broadcast pub/sub (lifecycle events + cancellation). Defaults to the (first)
   * transport when it can broadcast (event-emitter, BullMQ); set explicitly to use a dedicated one.
   */
  controlPlane?: ControlPlane;
  /** Interval (ms) for the durable-timer poller. `0` disables it. Defaults to 1000. Operator only. */
  timerPollMs?: number;
  /**
   * Auto-create the durable tables on boot via `store.ensureSchema()`. Defaults to true. Turn
   * off in production and call the store adapter's `ensure*DurableSchema()` from a migration.
   * Operator only.
   */
  autoSchema?: boolean;
  /**
   * Worker-pool namespace for this instance (forwarded to the engine). The poll paths
   * (`runPending`/`recoverIncomplete`/`resumeDueTimers`/`sweepTimeouts`) only act on runs in this
   * namespace. Set distinct values to safely share ONE state store across non-interchangeable
   * pools — e.g. a developer's local instance vs the deployed cluster. **Omit it to make this
   * instance an OPERATOR** — an unset namespace drives/recovers/resumes runs of EVERY namespace and
   * leaves the transport on its bare prefix. See `WorkflowEngineDeps.namespace`. Not to be confused
   * with {@link partition} (the co-located/thin-worker QUEUE routing suffix).
   */
  namespace?: string;
  /**
   * Multi-instance recovery lease, in ms — how long an instance owns a run it picked up before
   * another may take over. Defaults to 30000. Set above your longest synchronous run. Operator only.
   */
  leaseMs?: number;
  /** Unique id for this instance (for leases, and the co-located/thin-worker consumer's heartbeats). */
  instanceId?: string;
  /**
   * Cap recovery attempts before a still-`running` run is moved to the `dead` dead-letter state
   * (a poison pill that crashes the process every boot). Omit for unlimited. Operator only.
   */
  maxRecoveryAttempts?: number;
  /**
   * Opt-in liveness deadline (ms) for a remote (polyglot) workflow `advance`. If the worker neither
   * returns a decision nor sends a run-scoped heartbeat within this window, the engine presumes it dead
   * and lets recovery re-drive; each heartbeat rearms the window so a slow-but-alive worker is never
   * re-driven. Pair with a worker SDK that emits run-scoped heartbeats (`@dudousxd/durable-worker` ≥ the
   * release that ships them, and the Python `durable-worker`). Omit for the prior unbounded await.
   * Operator only.
   */
  remoteAdvanceSilenceMs?: number;
  /**
   * The **default** workflow to route dead-lettered runs to, for workflows that don't declare their
   * own. When a run is moved to `dead` (exceeded `maxRecoveryAttempts`), the started handler gets a
   * `DeadLetter` payload `{ deadRunId, workflow, input, error }` (idempotent by a `dlq:<runId>` id) —
   * it can alert, compensate, or queue for review. Resolution per dead run: the workflow's inline
   * `@DeadLetter()` method → its `@Workflow({ deadLetterWorkflow })` reference → this default. Omit
   * everything to just leave dead runs parked (inspectable + retriable from the dashboard). Accepts a
   * workflow class (refactor-safe) or a name (cross-runtime). Operator only.
   */
  deadLetterWorkflow?: WorkflowRef;
  /**
   * Whether an **operator** instance actively DRIVES runs — polls pending, recovers crashed
   * (`recoverIncomplete`), resumes due timers, sweeps timeouts, prunes retention, and consumes local
   * steps — as opposed to a read-only/dashboard replica. Defaults to `true`. Set `false` for a
   * **dashboard/dispatch-only** instance (e.g. an API pod) that mounts the store/dashboard but must
   * not process or recover workflows — leave that to another driving instance. `drive: false` also
   * installs the engine's no-op run dispatcher, so a freshly `start()`ed run stays enqueue-only until
   * a driving instance's poll picks it up. Ignored (irrelevant) for a thin worker (no `store`).
   */
  drive?: boolean;
  /** Max ms to wait for in-flight runs on shutdown before exiting. Defaults to 10000. Operator only. */
  shutdownTimeoutMs?: number;
  /**
   * Recurring workflows to start on a schedule (fixed interval or cron). The timer poller fires
   * them each tick on **driving** instances only; `engine.start` is idempotent by the schedule's
   * time-bucket run id, so racing instances start each window exactly once. Cron schedules need the
   * optional `cron-parser` peer dependency. Operator only.
   */
  schedules?: ScheduledWorkflow[];
  /**
   * Hard-prune terminal run history on an interval so `durable_workflow_runs` (and its child tables)
   * stays bounded — without it, completed/failed/cancelled runs accumulate forever and the timer
   * poller's per-tick status scans get linearly slower. Driving instances only. Omit to keep all
   * history (the default). Requires a store adapter that implements `pruneTerminalRuns` (the
   * MikroORM adapter does); other adapters no-op with a warning. See {@link DurableRetentionOptions}.
   * Operator only.
   */
  retention?: DurableRetentionOptions;
  /**
   * Build the public callback URL for a `ctx.webhook()` token, e.g.
   * ``(t) => `https://api.example.com/durable/api/webhooks/${t}` ``. Populates `DurableWebhook.url`
   * so a step can hand the URL to a third party. The dashboard's `POST webhooks/:token` receives the
   * callback. Omit to build URLs yourself from the token. Operator only.
   */
  webhookUrl?: (token: string) => string;
  /**
   * Flow-control queues for remote steps, registered on the engine at startup. Reference one from a
   * workflow with `ctx.step(handler, input, { queue: name })` to cap its concurrency / admission rate.
   * Operator only.
   */
  queues?: QueueConfig[];
  /**
   * Admission backend for the flow-control `queues`. Defaults to in-process (per-instance) caps. Pass
   * a `RedisAdmissionBackend` (from `@dudousxd/nestjs-durable-admission-redis`) to make concurrency /
   * rate-limit / priority ordering GLOBAL across every engine replica. Operator only.
   */
  admission?: AdmissionBackend;
  /**
   * Provide the current W3C `traceparent` to stamp on dispatched remote tasks, so workers continue
   * the distributed trace. Pass `otelTraceparent` from `@dudousxd/nestjs-durable-otel`. Operator only.
   */
  traceparent?: () => string | undefined;
  /**
   * Provide an opaque context carrier (tenant / user / correlation ids) to stamp on dispatched remote
   * tasks, so workers re-expose it to the step handler alongside the `traceparent`. The engine never
   * inspects its shape.
   *
   * **Auto-feed**: if you omit this AND `@dudousxd/nestjs-context` is installed (its accessor is bound
   * to the shared `CONTEXT_ACCESSOR` token), DurableModule defaults this to a reader that builds
   * `{ traceId, tenantId, userRef }` from the accessor — so a workflow dispatched within a request
   * automatically carries the originating context across process boundaries. Pass your own reader to
   * override the auto-feed; with neither, the carrier is omitted (unchanged behavior).
   *
   * Re-evaluated at each (re)dispatch — including a retry or a crash/scale-down resume that the engine
   * drives OUTSIDE the originating request scope, where this reader may return empty or stale values.
   * Treat the carrier as best-effort correlation/propagation metadata only — do NOT treat it as an
   * authorization boundary. Operator only.
   */
  context?: () => Record<string, unknown> | undefined;
  /** Attempts for each saga compensation when a run fails. Default 1 (no retry). Idempotent undos.
   *  Operator only. */
  compensationRetries?: number;
  /**
   * Opt into tenant read scoping: when `true` AND {@link namespace} is set, the module confines the
   * store's reads to that namespace (a tenant-boundary view) instead of the operator view that sees
   * all namespaces. Default `false` — the control plane (e.g. flip's `/ctrl` operator screens) stays
   * unscoped. Requires a store that exposes the `withScope` capability (the MikroORM adapter does);
   * a pre-built store without it is used as-is (construct it already-scoped instead). Operator only.
   */
  scopeReads?: boolean;
  /**
   * ioredis connection (string or options) for a **thin worker** (`connection` only) or the
   * **co-located worker** consumer (`store` + `connection`). Set this to play a worker role (see the
   * interface doc for the full role matrix). Omit to keep every `@Workflow` on the operator's inline
   * fast path with zero dispatch round-trips.
   */
  connection?: string | Record<string, unknown>;
  /**
   * The isolation partition a worker role serves — a thin worker's or co-located worker's queue
   * subscription, AND (for a co-located worker) the suffix each `@Workflow`'s dispatch token carries.
   * Each handler's queue token is `tenantGroup(sanitizeQueueToken(name), partition)`
   * (`@dudousxd/nestjs-durable-core`), so `undefined`, `''`, or `'default'` stays byte-identical to
   * the bare (sanitized) name (single-tenant deployment unchanged), and any other partition serves
   * `<name>@<partition>` — matching the queue name an operator's convention dispatch routes that
   * tenant's runs to (`tenantGroup(run.workflow, run.namespace)` on the engine side). Not to be
   * confused with {@link namespace} (the operator's own poll-scoping axis). Ignored for a plain
   * operator (no `connection`).
   */
  partition?: string;
  /** Key prefix namespacing the durable queues for a worker role's consumer. Defaults to `durable`
   *  (matches the transport). Ignored for a plain operator (no `connection`). */
  prefix?: string;
  /**
   * How many tasks a worker role's co-located/thin consumer runs concurrently PER SUBSCRIBED QUEUE
   * (BullMQ Worker concurrency — the same limit is applied to every per-name queue the single
   * `runRedisWorker` call starts). Defaults to 1. Raise it so a fanned-out batch (e.g. the N remote
   * steps of a `gather`) runs in parallel instead of serially.
   *
   * Pass `'adaptive'` (or `{ mode:'adaptive', ... }`) to let the consumer self-tune its concurrency
   * (latency gradient + RAM brake + backpressure) and publish a live status on its heartbeat. Ignored
   * for a plain operator (no `connection`).
   */
  concurrency?: ConcurrencyOption;
  /**
   * Per-handler concurrency override, keyed by workflow/step NAME. Falls back to {@link concurrency}
   * (then 1). NOT YET WIRED THROUGH: `runRedisWorker` (`@dudousxd/durable-worker`) currently applies
   * one {@link concurrency} limit uniformly across every per-name queue it subscribes to from a
   * single call — reserved here for when per-name concurrency lands there.
   */
  concurrencyByHandler?: Record<string, ConcurrencyOption>;
  /** Timeout for a thin worker's `RunGateway` round-trip over `transport` before it rejects. Defaults
   *  to 10_000ms inside `ProxyRunGateway`. Ignored for an operator (bound to `StoreRunGateway`). */
  runGatewayTimeoutMs?: number;
  /**
   * An explicit preset that NAMES the deployment role instead of leaving it to `store`/`connection`
   * inference, and VALIDATES the axes that are otherwise only prose (see the interface doc's role
   * matrix, and {@link namespace} vs {@link partition}). Omit to keep the existing inference —
   * `topology` is entirely additive and changes nothing when unset.
   *
   * **`namespace` vs `partition` — the two axes this preset locks down:**
   * - `namespace` is the OPERATOR's poll-scoping axis: which runs a control-plane instance
   *   drives/recovers/resumes (`runPending`/`recoverIncomplete`/`resumeDueTimers`/`sweepTimeouts`).
   *   Unset makes the instance see (drive) EVERY namespace.
   *   `{ role: 'control-plane' }` is the only preset that allows it.
   * - `partition` is the WORKER's queue-routing suffix: which queue a thin/co-located worker's
   *   consumer subscribes to (`<name>@<partition>`), matching the queue an operator's convention
   *   dispatch routes a run's `namespace` to. `{ role: 'tenant' }` sets this FOR you from `tenant` —
   *   you never set `partition` directly under `topology`.
   *
   * **One `tenant` word, two axes — the preset maps it to the right one per role:** on a
   * `control-plane` an optional `tenant` scopes the OPERATOR to its own runs (maps to `namespace` —
   * a self-contained local stack sharing a broker with a deployed cluster names itself so neither
   * drives the other's runs; leave it unset on a deployed operator to drive every tenant). On a
   * `tenant` role it is required and maps to `partition` (the worker's queue suffix).
   *
   * ```ts
   * // Control plane: owns the store, dispatches over the transport, prunes old runs. The optional
   * // `tenant` (e.g. from an env var) scopes this operator to its own runs — undefined on a
   * // deployed operator (drives everything), set on a local stack sharing the broker.
   * DurableModule.forRoot({
   *   topology: { role: 'control-plane', tenant: process.env.DURABLE_TENANT },
   *   store,
   *   transport,
   *   retention: { policies: [{ statuses: ['completed', 'cancelled'], maxAge: '14d' }] },
   * });
   *
   * // Tenant: store-less worker scoped to its own partition — `tenant` maps to `partition` for you.
   * DurableModule.forRoot({
   *   topology: { role: 'tenant', tenant: 'acme-corp' },
   *   connection: process.env.REDIS_URL,
   * });
   * ```
   *
   * Validated at `forRoot`/`forRootAsync` resolution time — see {@link DurableModule} for the exact
   * error messages, which double as the axis primer above.
   */
  topology?: { role: 'control-plane'; tenant?: string } | { role: 'tenant'; tenant: string };
}

export interface DurableModuleAsyncOptions {
  // `never[]` (not `object[]`) is intentional: a contravariant bottom-type rest param is what lets a
  // consumer supply a factory with concrete injected args, e.g. `(config: ConfigService) => …`.
  useFactory: (...args: never[]) => DurableModuleOptions | Promise<DurableModuleOptions>;
  inject?: InjectionToken[];
}

/** Throws the exact role-inference contract errors documented on {@link DurableModuleOptions}. */
function assertValidRole(options: DurableModuleOptions): void {
  const hasStore = options.store !== undefined;
  const hasConnection = options.connection !== undefined;
  if (!hasStore && !hasConnection) {
    throw new Error(
      'a durable module needs either a `store` (operator) or a `connection` (worker)',
    );
  }
  if (hasStore && options.transport === undefined && options.transports === undefined) {
    throw new Error('an operator (`store`) needs a `transport` (or `transports`)');
  }
}

/**
 * Validates the {@link DurableModuleOptions.topology} preset (a no-op when it's unset — existing
 * inference is untouched). Each thrown message NAMES the role, the offending option, and a one-line
 * explanation of the axis it protects — these messages are the feature: they teach `namespace` (the
 * operator's poll-scoping axis) apart from `partition`/`tenant` (the worker's queue-routing axis),
 * which today are only reconciled in consumer-app comments.
 */
function assertValidTopology(options: DurableModuleOptions): void {
  const topology = options.topology;
  if (topology === undefined) return;

  if (topology.role === 'control-plane') {
    if (
      options.store === undefined ||
      (options.transport === undefined && options.transports === undefined)
    ) {
      throw new Error(
        "topology: { role: 'control-plane' } needs `store` AND (`transport` or `transports`).\n" +
          'A control-plane node is the durable operator: it owns the state store and dispatches ' +
          'runs to workers over a transport — without both, there is nothing for it to operate.',
      );
    }
    if (options.partition !== undefined) {
      throw new Error(
        "topology: { role: 'control-plane' } forbids `partition`.\n" +
          'partition is the WORKER queue-routing suffix — on a control-plane node, runs are ' +
          "dispatched to tenant partitions via each run's namespace, not via this option. Set " +
          "`partition` (or `topology: { role: 'tenant', tenant }`) on the WORKER node instead.",
      );
    }
    if (
      topology.tenant !== undefined &&
      options.namespace !== undefined &&
      options.namespace !== topology.tenant
    ) {
      throw new Error(
        `topology: { role: 'control-plane', tenant: '${topology.tenant}' } conflicts with \`namespace: '${options.namespace}'\`.\ntenant maps 1:1 onto namespace (the operator's poll-scoping axis) — set only \`tenant\`, or set \`namespace\` to the same value.`,
      );
    }
    return;
  }

  if (options.connection === undefined) {
    throw new Error(
      `topology: { role: 'tenant', tenant: '${topology.tenant}' } needs \`connection\`.\nA tenant is a store-less worker: it connects to the broker directly to pull its own partition of tasks instead of polling a store it does not have.`,
    );
  }
  if (options.store !== undefined) {
    throw new Error(
      "topology: { role: 'tenant' } forbids `store`.\n" +
        'A tenant is store-less BY DEFINITION — a `store` present means you actually wanted ' +
        "`topology: { role: 'control-plane' }` (the store-owning role).",
    );
  }
  if (options.namespace !== undefined) {
    throw new Error(
      "topology: { role: 'tenant' } forbids `namespace`.\n" +
        "namespace is the OPERATOR's poll-scoping axis (which runs a control-plane instance " +
        'drives/recovers/resumes) — a tenant worker has no poll loop for it to scope. Use this ' +
        "preset's `tenant` field for the worker's own routing axis instead.",
    );
  }
  if (options.partition !== undefined && options.partition !== topology.tenant) {
    throw new Error(
      `topology: { role: 'tenant', tenant: '${topology.tenant}' } conflicts with \`partition: '${options.partition}'\`.\ntenant maps 1:1 onto partition (the worker queue-routing suffix) — set only \`tenant\`, or set \`partition\` to the same value.`,
    );
  }
}

/**
 * Applies the {@link DurableModuleOptions.topology} preset's `tenant` mapping — per role: onto
 * `partition` (worker queue-routing) for `{ role: 'tenant' }`, onto `namespace` (operator
 * poll-scoping) for `{ role: 'control-plane' }`. Validated already by {@link assertValidTopology}
 * (an equal explicit value is a no-op; a mismatched one throws before this runs). A no-op for an
 * unset `topology` (existing behavior, zero change).
 */
function resolveTopology(options: DurableModuleOptions): DurableModuleOptions {
  const topology = options.topology;
  if (topology === undefined) return options;
  if (topology.role === 'control-plane') {
    // An optional tenant scopes the operator to its own runs — maps onto `namespace` (undefined =
    // global operator, drives every tenant; validated against an explicit mismatched `namespace`).
    // The namespace stays a STORE-side axis: the engine stamps runs with it and routes their work
    // via `@<tenant>` GROUP suffixes on the transport's own prefix (the cross-SDK convention every
    // tenant worker speaks natively) — it never re-scopes the transport keyspace.
    if (topology.tenant === undefined || options.namespace !== undefined) return options;
    return { ...options, namespace: topology.tenant };
  }
  if (options.partition !== undefined) return options;
  return { ...options, partition: topology.tenant };
}

/**
 * Boot-time wiring for the tenant run gateway's OPERATOR side, gated by {@link isDrivingOperator} (an
 * operator instance drives by default; `drive: false` — or a thin worker with no `store` at all —
 * does not). Two independent capabilities, each wired only when the transport carries it:
 *
 * 1. **`RunRequestResponder`** — answers a tenant's {@link RunRequest} against the bound
 *    {@link RUN_GATEWAY}, tenant-scoped. Wired when the transport implements both
 *    `onRunRequest`/`publishRunReply` (only broker transports carry the protocol).
 * 2. **Tenant-event re-publisher** ({@link TenantEventRepublisher}) — mirrors every engine
 *    lifecycle event onto its run's per-tenant channel via `publishTenantEvent`, so a store-less
 *    tenant worker can live-tail its OWN runs. See that class for the namespace-resolution and
 *    cache-eviction details.
 */
@Injectable()
class RunGatewayBootstrap implements OnApplicationBootstrap, OnModuleDestroy {
  private unsubscribe?: () => void;

  constructor(
    private readonly engine: WorkflowEngine,
    @Inject(TRANSPORT_CANONICAL) private readonly transport: Transport | null,
    private readonly gateway: RunGateway,
    @Inject(STATE_STORE_CANONICAL) private readonly store: StateStore | null,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!isDrivingOperator(this.options) || !this.transport) return;
    const store = this.store;
    if (!store) return; // unreachable when isDrivingOperator is true — keeps types honest

    const { onRunRequest, publishRunReply, publishTenantEvent } = this.transport;
    if (typeof onRunRequest === 'function' && typeof publishRunReply === 'function') {
      // Bind to the transport: these are real methods that touch the transport's private fields
      // (e.g. BullMQTransport's `this.#runRequestName()`), so they must keep their receiver — passing
      // them destructured/unbound makes `this` the literal below and throws "Receiver must be an
      // instance of class" on first use. (Mirrors the `publishTenantEvent.bind` just below.)
      const runRequestTransport: RunRequestTransport = {
        onRunRequest: onRunRequest.bind(this.transport),
        publishRunReply: publishRunReply.bind(this.transport),
      };
      new RunRequestResponder(runRequestTransport, this.gateway).start();
    }

    if (typeof publishTenantEvent === 'function') {
      const republisher = new TenantEventRepublisher(
        store,
        publishTenantEvent.bind(this.transport),
      );
      this.unsubscribe = this.engine.subscribe((event) => {
        void republisher.handle(event);
      });
    }
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }
}

@Module({})
export class DurableModule {
  static forRoot(options: DurableModuleOptions): DynamicModule {
    DurableModule.assertValid(options);
    return DurableModule.build({
      provide: DURABLE_OPTIONS_CANONICAL,
      useValue: resolveTopology(options),
    });
  }

  static forRootAsync(options: DurableModuleAsyncOptions): DynamicModule {
    return DurableModule.build({
      provide: DURABLE_OPTIONS_CANONICAL,
      useFactory: async (...args: Parameters<DurableModuleAsyncOptions['useFactory']>) => {
        const resolved = await options.useFactory(...args);
        DurableModule.assertValid(resolved);
        return resolveTopology(resolved);
      },
      inject: options.inject ?? [],
    });
  }

  /**
   * Validates role/axis constraints, in resolution order. When {@link DurableModuleOptions.topology}
   * is set, it OWNS validation — {@link assertValidTopology}'s own store/transport/connection checks
   * are strictly stronger than {@link assertValidRole}'s, so the topology-specific, axis-teaching
   * message is what a `topology`-opted-in consumer sees (not the older generic one). Falls back to
   * {@link assertValidRole} unchanged when `topology` is absent — zero behavior change.
   */
  private static assertValid(options: DurableModuleOptions): void {
    if (options.topology !== undefined) {
      assertValidTopology(options);
      return;
    }
    assertValidRole(options);
  }

  private static build(optionsProvider: Provider): DynamicModule {
    return {
      module: DurableModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        optionsProvider,
        {
          provide: STATE_STORE_CANONICAL,
          useFactory: (options: DurableModuleOptions): StateStore | null =>
            options.store !== undefined ? scopedStore(options.store, options) : null,
          inject: [DURABLE_OPTIONS_CANONICAL],
        },
        {
          provide: TRANSPORT_CANONICAL,
          // With a POOL (`transports`) and no singular `transport`, the canonical transport is the
          // pool's PRIMARY — the same one the engine dispatches on first. Leaving it null starved
          // the step registrar / in-app worker of a transport, so a pool-configured operator
          // registered NO step handlers and its own steps parked in `wait` with no consumer.
          useFactory: (options: DurableModuleOptions) =>
            options.transport ?? options.transports?.[0]?.transport ?? null,
          inject: [DURABLE_OPTIONS_CANONICAL],
        },
        // Legacy back-compat aliases (deprecated tokens still resolve to the same instances):
        { provide: STATE_STORE, useExisting: STATE_STORE_CANONICAL },
        { provide: TRANSPORT, useExisting: TRANSPORT_CANONICAL },
        { provide: DURABLE_OPTIONS, useExisting: DURABLE_OPTIONS_CANONICAL },
        {
          // Shared token, bound EXACTLY once: a real engine for the operator role, or a store-less
          // `DurableStartClient` facade for a thin worker (no `store`) — either way, `WorkflowService`
          // and app code call `engine.start(...)` unchanged.
          provide: WorkflowEngine,
          useFactory: async (
            options: DurableModuleOptions,
            store: StateStore | null,
            transport: Transport | null,
            // The accessor from `@dudousxd/nestjs-context` is resolved at construction via ModuleRef
            // (shared CONTEXT_ACCESSOR symbol — no hard import). Absent → unchanged behavior.
            moduleRef: ModuleRef,
          ) => {
            if (options.store === undefined) {
              return new DurableStartClient(options);
            }
            if (!store) {
              throw new Error(
                'unreachable: STATE_STORE_CANONICAL must resolve a store when options.store is set',
              );
            }
            // The control-plane default is the primary task transport (single, or the pool's first)
            // when it can broadcast.
            const primary = transport ?? options.transports?.[0]?.transport;
            // Auto-feed the carrier from nestjs-context when an accessor is present AND the app didn't
            // pass its own `context` reader. The app's own reader always wins; with no accessor the
            // carrier stays `undefined` (unchanged behavior — `traceparent` etc. still work).
            const accessor = resolveAccessor(moduleRef);
            const context =
              options.context ?? (accessor ? () => carrierFromAccessor(accessor) : undefined);
            // Consume side: when nestjs-context is present (an accessor is bound), re-hydrate the
            // originating context AROUND each local step body, so a `@Step` reader sees the
            // tenant/user/trace ids ambiently via nestjs-context's ALS — no consumer wrapping needed.
            // The runtime `Context` is a module-level singleton (not the accessor token), resolved
            // ONCE here via a guarded dynamic import (optional peer — failure leaves the default
            // passthrough). Best-effort: an empty/undefined carrier just runs the handler normally.
            const runtime = accessor ? await resolveContextRuntime() : undefined;
            const rehydrate =
              runtime &&
              (<T>(carrier: Record<string, unknown> | undefined, fn: () => T): T =>
                carrier && Object.keys(carrier).length > 0
                  ? runtime.deserialize(carrier, fn)
                  : fn());
            const engine = new WorkflowEngine({
              store,
              transport: transport ?? undefined,
              transports: options.transports,
              controlPlane: options.controlPlane ?? (isControlPlane(primary) ? primary : undefined),
              leaseMs: options.leaseMs,
              admission: options.admission,
              maxRecoveryAttempts: options.maxRecoveryAttempts,
              remoteAdvanceSilenceMs: options.remoteAdvanceSilenceMs,
              instanceId: options.instanceId,
              namespace: options.namespace,
              webhookUrl: options.webhookUrl,
              traceparent: options.traceparent,
              context,
              rehydrate: rehydrate || undefined,
              compensationRetries: options.compensationRetries,
              // A non-driving (dashboard/API) operator must not run workflows: enqueue-only, leaving
              // each `pending` run in the store for a DRIVING instance's poll. A driving operator gets
              // the engine's default in-process dispatcher: for a body registered inline, it runs
              // locally; for one registered GROUP-SERVED (co-located worker) or left unregistered, the
              // SAME default dispatcher routes it out remotely (group-served executor, or convention
              // dispatch — always on) instead.
              runDispatcher: options.drive === false ? { dispatch: () => {} } : undefined,
            });
            for (const queue of options.queues ?? []) engine.registerQueue(queue);
            // Dead-letter routing (per-workflow `@DeadLetter()` / `deadLetterWorkflow` + this global
            // default) is wired by the WorkflowRegistrar, which owns the `@Workflow` metadata.
            return engine;
          },
          inject: [
            DURABLE_OPTIONS_CANONICAL,
            STATE_STORE_CANONICAL,
            TRANSPORT_CANONICAL,
            ModuleRef,
          ],
        },
        WorkflowService,
        EntityService,
        WorkflowRegistrar,
        DurableStepRegistrar,
        TimerPoller,
        RetentionPoller,
        // Tenant run gateway: bound EXACTLY once — the store-backed `StoreRunGateway` for an operator,
        // or (for a thin worker, no `store`) a `ProxyRunGateway` over `transport` when given, else a
        // gateway whose every method rejects with a clear tenant error.
        {
          provide: RunGateway,
          useFactory: (
            options: DurableModuleOptions,
            store: StateStore | null,
            engine: WorkflowEngine,
          ): RunGateway => {
            if (options.store !== undefined) {
              if (!store) {
                throw new Error(
                  'unreachable: STATE_STORE_CANONICAL must resolve a store when options.store is set',
                );
              }
              return new StoreRunGateway(store, engine);
            }
            return options.transport
              ? new ProxyRunGateway(
                  options.transport,
                  options.partition ?? 'default',
                  options.runGatewayTimeoutMs,
                )
              : unavailableRunGateway();
          },
          inject: [DURABLE_OPTIONS_CANONICAL, STATE_STORE_CANONICAL, WorkflowEngine],
        },
        RunGatewayBootstrap,
        // Co-located in-app worker (uniform dispatch): inert unless BOTH `store` and `connection` are
        // set — see `in-app-worker.ts`.
        ...inAppWorkerProviders(),
        // Pure thin-worker consumer: inert unless `connection` is set WITHOUT `store` — see
        // `durable-worker.module.ts`.
        ...thinWorkerProviders(),
      ],
      exports: [
        WorkflowService,
        EntityService,
        WorkflowEngine,
        STATE_STORE,
        STATE_STORE_CANONICAL,
        TRANSPORT,
        TRANSPORT_CANONICAL,
        DURABLE_OPTIONS_CANONICAL,
        RunGateway,
      ],
    };
  }
}
