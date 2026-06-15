import {
  type ControlPlane,
  DURABLE_OPTIONS,
  type NamedTransport,
  type QueueConfig,
  STATE_STORE,
  type ScheduledWorkflow,
  type StateStore,
  TRANSPORT,
  type Transport,
  WorkflowEngine,
  type WorkflowRef,
} from '@dudousxd/nestjs-durable-core';
import { type DynamicModule, type InjectionToken, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DurableStepRegistrar } from './durable-step.registrar';
import { EntityService } from './entity';
import { TimerPoller } from './timer-poller';
import { WorkflowRegistrar } from './workflow.registrar';
import { WorkflowService } from './workflow.service';

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
   * Provide the current W3C `traceparent` to stamp on dispatched remote tasks, so workers continue
   * the distributed trace. Pass `otelTraceparent` from `@dudousxd/nestjs-durable-otel`.
   */
  traceparent?: () => string | undefined;
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
        {
          provide: WorkflowEngine,
          useFactory: (
            store: StateStore,
            transport: Transport | null,
            opts: DurableModuleOptions,
          ) => {
            // The control-plane default is the primary task transport (single, or the pool's first)
            // when it can broadcast.
            const primary = transport ?? opts.transports?.[0]?.transport;
            const engine = new WorkflowEngine({
              store,
              transport: transport ?? undefined,
              transports: opts.transports,
              controlPlane: opts.controlPlane ?? (isControlPlane(primary) ? primary : undefined),
              leaseMs: opts.leaseMs,
              maxRecoveryAttempts: opts.maxRecoveryAttempts,
              instanceId: opts.instanceId,
              webhookUrl: opts.webhookUrl,
              traceparent: opts.traceparent,
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
          inject: [STATE_STORE, TRANSPORT, DURABLE_OPTIONS],
        },
        WorkflowService,
        EntityService,
        WorkflowRegistrar,
        DurableStepRegistrar,
        TimerPoller,
      ],
      exports: [WorkflowService, EntityService, WorkflowEngine, STATE_STORE, TRANSPORT],
    };
  }
}
