import {
  DurableWorkerRuntime,
  type RunRedisWorkerOptions,
  type RunningWorker,
  runRedisWorker as defaultRunRedisWorker,
} from '@dudousxd/durable-worker';
import {
  type DynamicModule,
  Inject,
  Injectable,
  type InjectionToken,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { scanSteps, scanWorkflows } from './discovery-helpers';

/**
 * Options for a **store-less thin worker** process: where to consume (`connection`/`prefix`) and
 * which worker `groups` this process serves. There is deliberately NO `store`, `transport`, engine,
 * dashboard, recovery, or timer config — a thin worker only registers `@Workflow`/`@DurableStep`
 * handlers and runs the BullMQ consumer (see {@link DurableWorkerModule}).
 */
export interface DurableWorkerModuleOptions {
  /** ioredis connection (string or options), as `runRedisWorker` / `BullMQTransport` accept. */
  connection: string | Record<string, unknown>;
  /** The worker groups this process serves — one BullMQ consumer is started per group. */
  groups: string[];
  /** Key prefix namespacing the durable queues. Defaults to `durable` (matches the transport). */
  prefix?: string;
  /** Stable id for this worker process in heartbeats/control. Defaults to a per-host/pid id. */
  instanceId?: string;
  /**
   * How many tasks each group's consumer runs concurrently (BullMQ Worker concurrency). Defaults to 1.
   * Applies to every group unless overridden per-group by {@link concurrencyByGroup}. Raise it so a
   * fanned-out batch (e.g. the N remote steps of a `gather`) runs in parallel instead of serially.
   */
  concurrency?: number;
  /** Per-group concurrency override, keyed by group name. Falls back to {@link concurrency} (then 1). */
  concurrencyByGroup?: Record<string, number>;
}

export interface DurableWorkerModuleAsyncOptions {
  useFactory: (
    ...args: never[]
  ) => DurableWorkerModuleOptions | Promise<DurableWorkerModuleOptions>;
  inject?: InjectionToken[];
}

/** The resolved {@link DurableWorkerModuleOptions} (canonical token). */
export const DURABLE_WORKER_OPTIONS = Symbol('nestjs-durable:worker-options');

/**
 * The `runRedisWorker` function the module uses to start each group's BullMQ consumer. Defaults to
 * the real one from `@dudousxd/durable-worker`; tests `overrideProvider` it with a fake so no real
 * Redis is needed.
 */
export const RUN_REDIS_WORKER = Symbol('nestjs-durable:run-redis-worker');

/** The list of started {@link RunningWorker} handles (one per group), closed on shutdown. */
export const DURABLE_WORKER_RUNNERS = Symbol('nestjs-durable:worker-runners');

/** The signature of `runRedisWorker` — injected behind {@link RUN_REDIS_WORKER}. */
export type RunRedisWorkerFn = (opts: RunRedisWorkerOptions) => Promise<RunningWorker>;

/**
 * Discovers every provider carrying `@Workflow` metadata and registers its `run(ctx, input)` on the
 * thin {@link DurableWorkerRuntime}. Mirrors the engine-side `WorkflowRegistrar`, but registers on
 * the runner-core runtime instead of a `WorkflowEngine` — the runtime drives `run` with the thin
 * `WorkflowContext` (which `implements WorkflowCtx`), so the body runs unchanged. NO store/engine.
 */
@Injectable()
export class ThinWorkflowRegistrar implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly runtime: DurableWorkerRuntime,
  ) {}

  onModuleInit(): void {
    scanWorkflows(this.discovery, (meta, instance) =>
      this.runtime.registerWorkflow(meta.name, (ctx, input) => instance.run(ctx, input)),
    );
  }
}

/**
 * Discovers every `@DurableStep` method and registers it as a step handler on the thin
 * {@link DurableWorkerRuntime}. Mirrors the engine-side `DurableStepRegistrar`, but always registers
 * on the runtime (a thin worker IS the consumer — there is no in-process-vs-queue branch).
 */
@Injectable()
export class ThinStepRegistrar implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly runtime: DurableWorkerRuntime,
  ) {}

  onModuleInit(): void {
    scanSteps(this.discovery, this.metadataScanner, (meta, handler) =>
      this.runtime.registerStep(meta.name, handler),
    );
  }
}

/**
 * Starts one BullMQ consumer per configured group on bootstrap (after both registrars have run, so
 * every handler is registered before any task is consumed) and closes them on shutdown. The only
 * runtime side effect of a thin worker: register handlers, run the consumer. No engine, no store,
 * no recovery, no timers, no dispatch.
 *
 * For the shutdown close to fire, enable Nest's shutdown hooks: `app.enableShutdownHooks()`.
 */
@Injectable()
export class ThinWorkerBootstrap implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly runners: RunningWorker[] = [];

  constructor(
    private readonly runtime: DurableWorkerRuntime,
    @Inject(DURABLE_WORKER_OPTIONS) private readonly options: DurableWorkerModuleOptions,
    @Inject(RUN_REDIS_WORKER) private readonly runRedisWorker: RunRedisWorkerFn,
    @Inject(DURABLE_WORKER_RUNNERS) private readonly runnersSink: RunningWorker[],
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const group of this.options.groups) {
      const handle = await this.runRedisWorker({
        runtime: this.runtime,
        group,
        connection: this.options.connection,
        ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
        ...(this.options.instanceId !== undefined ? { instanceId: this.options.instanceId } : {}),
        ...((this.options.concurrencyByGroup?.[group] ?? this.options.concurrency) !== undefined
          ? { concurrency: this.options.concurrencyByGroup?.[group] ?? this.options.concurrency }
          : {}),
      });
      this.runners.push(handle);
      this.runnersSink.push(handle);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.runners.map((h) => h.close()));
  }
}

/**
 * A NestJS dynamic module that turns an app into a **PURE durable worker**: it discovers
 * `@Workflow`/`@DurableStep` providers, registers them on the thin {@link DurableWorkerRuntime}, and
 * runs one BullMQ consumer per group via `runRedisWorker`. It is **control-plane-less** — it binds
 * NO `WorkflowEngine`, NO store/ORM, NO dashboard, NO timer poller, NO recovery, and NO run dispatch.
 * Use it for a worker pod that only executes work an engine elsewhere coordinates.
 *
 * Contrast with `DurableModule` (`worker: true`), which is a full control plane WITH a store: this
 * module is the store-less half. A workflow body runs identically on either (conformance-tested).
 */
@Module({})
export class DurableWorkerModule {
  static forRoot(options: DurableWorkerModuleOptions): DynamicModule {
    return DurableWorkerModule.build({ provide: DURABLE_WORKER_OPTIONS, useValue: options });
  }

  static forRootAsync(options: DurableWorkerModuleAsyncOptions): DynamicModule {
    return DurableWorkerModule.build({
      provide: DURABLE_WORKER_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    });
  }

  private static build(optionsProvider: Provider): DynamicModule {
    return {
      module: DurableWorkerModule,
      imports: [DiscoveryModule],
      providers: [
        optionsProvider,
        { provide: DurableWorkerRuntime, useFactory: () => new DurableWorkerRuntime() },
        { provide: RUN_REDIS_WORKER, useValue: defaultRunRedisWorker },
        { provide: DURABLE_WORKER_RUNNERS, useValue: [] as RunningWorker[] },
        ThinWorkflowRegistrar,
        ThinStepRegistrar,
        ThinWorkerBootstrap,
      ],
      exports: [DurableWorkerRuntime],
    };
  }
}
