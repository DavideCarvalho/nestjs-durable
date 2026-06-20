import {
  type AdmissionBackend,
  type ControlPlane,
  DURABLE_OPTIONS,
  DURABLE_OPTIONS_CANONICAL,
  type NamedTransport,
  type QueueConfig,
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
import { type DynamicModule, type InjectionToken, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule, ModuleRef } from '@nestjs/core';
import type { ContextAccessor } from './context-accessor';
import { DurableStepRegistrar } from './durable-step.registrar';
import { EntityService } from './entity';
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

export interface DurableModuleOptions {
  store: StateStore;
  transport?: Transport;
  /**
   * An ordered pool of named transports for failover / multi-broker setups. The engine dispatches on
   * the first and fails over to the next; a step pins one via `ctx.call(step, input, { transport })`.
   * Use instead of `transport`.
   */
  transports?: NamedTransport[];
  /**
   * Cross-instance broadcast pub/sub (lifecycle events + cancellation). Defaults to the (first)
   * transport when it can broadcast (event-emitter, BullMQ); set explicitly to use a dedicated one.
   */
  controlPlane?: ControlPlane;
  /** Interval (ms) for the durable-timer poller. `0` disables it. Defaults to 1000. */
  timerPollMs?: number;
  /**
   * Auto-create the durable tables on boot via `store.ensureSchema()`. Defaults to true. Turn
   * off in production and call the store adapter's `ensure*DurableSchema()` from a migration.
   */
  autoSchema?: boolean;
  /**
   * Multi-instance recovery lease, in ms — how long an instance owns a run it picked up before
   * another may take over. Defaults to 30000. Set above your longest synchronous run.
   */
  leaseMs?: number;
  /** Unique id for this instance (for leases). Defaults to a random id. */
  instanceId?: string;
  /**
   * Cap recovery attempts before a still-`running` run is moved to the `dead` dead-letter state
   * (a poison pill that crashes the process every boot). Omit for unlimited.
   */
  maxRecoveryAttempts?: number;
  /**
   * The **default** workflow to route dead-lettered runs to, for workflows that don't declare their
   * own. When a run is moved to `dead` (exceeded `maxRecoveryAttempts`), the started handler gets a
   * `DeadLetter` payload `{ deadRunId, workflow, input, error }` (idempotent by a `dlq:<runId>` id) —
   * it can alert, compensate, or queue for review. Resolution per dead run: the workflow's inline
   * `@DeadLetter()` method → its `@Workflow({ deadLetterWorkflow })` reference → this default. Omit
   * everything to just leave dead runs parked (inspectable + retriable from the dashboard). Accepts a
   * workflow class (refactor-safe) or a name (cross-runtime).
   */
  deadLetterWorkflow?: WorkflowRef;
  /**
   * Whether this instance plays the **worker** role: register `@DurableStep` handlers (consume the
   * transport), recover incomplete runs on boot, and poll due timers. Defaults to `true`. Set
   * `false` for a **dashboard/dispatch-only** instance (e.g. an API pod) that mounts the control
   * plane and reads the store but must not process or recover workflows — leave that to the workers.
   */
  worker?: boolean;
  /** Max ms to wait for in-flight runs on shutdown before exiting. Defaults to 10000. */
  shutdownTimeoutMs?: number;
  /**
   * Recurring workflows to start on a schedule (fixed interval or cron). The timer poller fires
   * them each tick on **worker** instances only; `engine.start` is idempotent by the schedule's
   * time-bucket run id, so racing instances start each window exactly once. Cron schedules need the
   * optional `cron-parser` peer dependency.
   */
  schedules?: ScheduledWorkflow[];
  /**
   * Build the public callback URL for a `ctx.webhook()` token, e.g.
   * ``(t) => `https://api.example.com/durable/api/webhooks/${t}` ``. Populates `DurableWebhook.url`
   * so a step can hand the URL to a third party. The dashboard's `POST webhooks/:token` receives the
   * callback. Omit to build URLs yourself from the token.
   */
  webhookUrl?: (token: string) => string;
  /**
   * Flow-control queues for remote steps, registered on the engine at startup. Reference one from a
   * workflow with `ctx.call(step, input, { queue: name })` to cap its concurrency / admission rate.
   */
  queues?: QueueConfig[];
  /**
   * Admission backend for the flow-control `queues`. Defaults to in-process (per-instance) caps. Pass
   * a `RedisAdmissionBackend` (from `@dudousxd/nestjs-durable-admission-redis`) to make concurrency /
   * rate-limit / priority ordering GLOBAL across every engine replica.
   */
  admission?: AdmissionBackend;
  /**
   * Provide the current W3C `traceparent` to stamp on dispatched remote tasks, so workers continue
   * the distributed trace. Pass `otelTraceparent` from `@dudousxd/nestjs-durable-otel`.
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
   * authorization boundary.
   */
  context?: () => Record<string, unknown> | undefined;
  /** Attempts for each saga compensation when a run fails. Default 1 (no retry). Idempotent undos. */
  compensationRetries?: number;
}

export interface DurableModuleAsyncOptions {
  useFactory: (...args: never[]) => DurableModuleOptions | Promise<DurableModuleOptions>;
  inject?: InjectionToken[];
}

@Module({})
export class DurableModule {
  static forRoot(options: DurableModuleOptions): DynamicModule {
    return DurableModule.build({ provide: DURABLE_OPTIONS, useValue: options });
  }

  static forRootAsync(options: DurableModuleAsyncOptions): DynamicModule {
    return DurableModule.build({
      provide: DURABLE_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    });
  }

  private static build(optionsProvider: Provider): DynamicModule {
    return {
      module: DurableModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        optionsProvider,
        {
          provide: STATE_STORE,
          useFactory: (options: DurableModuleOptions) => options.store,
          inject: [DURABLE_OPTIONS],
        },
        {
          provide: TRANSPORT,
          useFactory: (options: DurableModuleOptions) => options.transport ?? null,
          inject: [DURABLE_OPTIONS],
        },
        { provide: STATE_STORE_CANONICAL, useExisting: STATE_STORE },
        { provide: TRANSPORT_CANONICAL, useExisting: TRANSPORT },
        { provide: DURABLE_OPTIONS_CANONICAL, useExisting: DURABLE_OPTIONS },
        {
          provide: WorkflowEngine,
          useFactory: async (
            store: StateStore,
            transport: Transport | null,
            opts: DurableModuleOptions,
            // The accessor from `@dudousxd/nestjs-context` is resolved at construction via ModuleRef
            // (shared CONTEXT_ACCESSOR symbol — no hard import). Absent → unchanged behavior.
            moduleRef: ModuleRef,
          ) => {
            // The control-plane default is the primary task transport (single, or the pool's first)
            // when it can broadcast.
            const primary = transport ?? opts.transports?.[0]?.transport;
            // Auto-feed the carrier from nestjs-context when an accessor is present AND the app didn't
            // pass its own `context` reader. The app's own reader always wins; with no accessor the
            // carrier stays `undefined` (unchanged behavior — `traceparent` etc. still work).
            const accessor = resolveAccessor(moduleRef);
            const context =
              opts.context ?? (accessor ? () => carrierFromAccessor(accessor) : undefined);
            // Consume side: when nestjs-context is present (an accessor is bound), re-hydrate the
            // originating context AROUND each local step body, so a `@DurableStep` reader sees the
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
              transports: opts.transports,
              controlPlane: opts.controlPlane ?? (isControlPlane(primary) ? primary : undefined),
              leaseMs: opts.leaseMs,
              admission: opts.admission,
              maxRecoveryAttempts: opts.maxRecoveryAttempts,
              instanceId: opts.instanceId,
              webhookUrl: opts.webhookUrl,
              traceparent: opts.traceparent,
              context,
              rehydrate: rehydrate || undefined,
              compensationRetries: opts.compensationRetries,
              // A non-worker (API/dashboard) instance must not run workflows: enqueue-only, leaving
              // each `pending` run in the store for a worker's `runPending` poll. Workers use the
              // default in-process dispatcher (execute locally).
              runDispatcher: opts.worker === false ? { dispatch: () => {} } : undefined,
            });
            for (const queue of opts.queues ?? []) engine.registerQueue(queue);
            // Dead-letter routing (per-workflow `@DeadLetter()` / `deadLetterWorkflow` + this global
            // default) is wired by the WorkflowRegistrar, which owns the `@Workflow` metadata.
            return engine;
          },
          inject: [STATE_STORE, TRANSPORT, DURABLE_OPTIONS, ModuleRef],
        },
        WorkflowService,
        EntityService,
        WorkflowRegistrar,
        DurableStepRegistrar,
        TimerPoller,
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
      ],
    };
  }
}
