import {
  DURABLE_OPTIONS,
  type ScheduledWorkflow,
  STATE_STORE,
  type StateStore,
  TRANSPORT,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { type DynamicModule, type InjectionToken, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DurableStepRegistrar } from './durable-step.registrar';
import { TimerPoller } from './timer-poller';
import { WorkflowRegistrar } from './workflow.registrar';
import { WorkflowService } from './workflow.service';

export interface DurableModuleOptions {
  store: StateStore;
  transport?: Transport;
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
          ) =>
            new WorkflowEngine({
              store,
              transport: transport ?? undefined,
              leaseMs: opts.leaseMs,
              instanceId: opts.instanceId,
              webhookUrl: opts.webhookUrl,
            }),
          inject: [STATE_STORE, TRANSPORT, DURABLE_OPTIONS],
        },
        WorkflowService,
        WorkflowRegistrar,
        DurableStepRegistrar,
        TimerPoller,
      ],
      exports: [WorkflowService, WorkflowEngine, STATE_STORE, TRANSPORT],
    };
  }
}
