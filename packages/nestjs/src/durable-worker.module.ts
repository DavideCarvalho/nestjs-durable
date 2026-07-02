import {
  type ConcurrencyOption,
  DurableWorkerRuntime,
  type RunRedisWorkerOptions,
  type RunningWorker,
  runRedisWorker as defaultRunRedisWorker,
} from '@dudousxd/durable-worker';
import type {
  EngineEvent,
  RunDetail,
  RunGateway,
  RunQuery,
  RunResult,
  Transport,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
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
import { DurableStartClient } from './durable-start-client';
import { ProxyRunGateway } from './proxy-run-gateway';
import { RUN_GATEWAY } from './tokens';
import { WorkflowService } from './workflow.service';

/**
 * Options for a **store-less thin worker** process: where to consume (`connection`/`prefix`) and
 * which `partition` this process serves. There is deliberately NO `store`, `transport`, engine,
 * dashboard, recovery, or timer config — a thin worker only registers `@Workflow`/`@Step`
 * handlers and runs the BullMQ consumer (see {@link DurableWorkerModule}).
 *
 * Subscription is no longer a hand-declared axis: the module discovers every `@Workflow`/`@Step`
 * provider, registers it on the thin `DurableWorkerRuntime`, and starts ONE `runRedisWorker` call
 * that subscribes one queue PER REGISTERED NAME (`DurableWorkerRuntime.registeredNames()`,
 * `@dudousxd/durable-worker`) — not one consumer per hand-declared group.
 */
export interface DurableWorkerModuleOptions {
  /** ioredis connection (string or options), as `runRedisWorker` / `BullMQTransport` accept. */
  connection: string | Record<string, unknown>;
  /**
   * @deprecated No longer the subscription axis. Subscription is derived from every discovered
   * `@Workflow`/`@Step` handler (one queue per registered name) instead of a hand-declared group
   * list. Accepted for source back-compat and ignored.
   */
  groups?: string[];
  /**
   * The isolation partition this worker process serves. Each registered handler's queue token is
   * suffixed via `tenantGroup(sanitizeQueueToken(name), partition)` (`@dudousxd/nestjs-durable-core`),
   * so `undefined`, `''`, or `'default'` stays byte-identical to the bare (sanitized) name
   * (production unchanged), and any other partition serves `<name>@<partition>` — matching the
   * queue name an OPERATOR control plane's `remoteByConvention` routes that tenant's runs to
   * (`tenantGroup(run.workflow, run.namespace)` on the engine side).
   */
  partition?: string;
  /** @deprecated Use {@link partition} instead — a back-compat alias mapped onto it (only used when
   *  `partition` itself is unset). */
  tenant?: string;
  /** Key prefix namespacing the durable queues. Defaults to `durable` (matches the transport). */
  prefix?: string;
  /** Stable id for this worker process in heartbeats/control. Defaults to a per-host/pid id. */
  instanceId?: string;
  /**
   * How many tasks this worker runs concurrently PER SUBSCRIBED QUEUE (BullMQ Worker concurrency —
   * the same limit is applied to every per-name queue the single `runRedisWorker` call starts).
   * Defaults to 1. Raise it so a fanned-out batch (e.g. the N remote steps of a `gather`) runs in
   * parallel instead of serially.
   *
   * Pass `'adaptive'` (or `{ mode:'adaptive', ... }`) to let the consumer self-tune its concurrency
   * (latency gradient + RAM brake + backpressure) and publish a live status on its heartbeat.
   */
  concurrency?: ConcurrencyOption;
  /**
   * Per-handler concurrency override, keyed by workflow/step NAME. Falls back to {@link concurrency}
   * (then 1). NOT YET WIRED THROUGH: `runRedisWorker` (`@dudousxd/durable-worker`) currently applies
   * one {@link concurrency} limit uniformly across every per-name queue it subscribes to from a
   * single call — reserved here for when per-name concurrency lands there.
   */
  concurrencyByHandler?: Record<string, ConcurrencyOption>;
  /** @deprecated Use {@link concurrencyByHandler} (keyed by handler name, not group). Never wired
   *  through — there is no more per-group loop to key by. Accepted for source back-compat only. */
  concurrencyByGroup?: Record<string, ConcurrencyOption>;
  /**
   * A persistent transport (reply/tenant-event subscriber) this tenant worker uses to bind
   * `RUN_GATEWAY` to a {@link ProxyRunGateway}, so a controller can `getRunDetail`/`listRuns`/
   * `cancel`/`retry`/`continue`/`retryWithInput`/`subscribe` against ITS OWN runs without a DB.
   * Deliberately optional and app-supplied (not `connection`-derived) — the generic nestjs package
   * stays free of any transport dependency; a tenant that wants `RunGateway` passes e.g.
   * `new BullMQTransport({ connection, group })` from `@dudousxd/nestjs-durable-transport-bullmq`.
   * Absent means `RUN_GATEWAY` resolves to a gateway whose every method rejects with a clear error.
   */
  transport?: Transport;
  /** Timeout for a `RunGateway` round-trip over {@link transport} before it rejects. Defaults to
   *  10_000ms inside `ProxyRunGateway`. */
  runGatewayTimeoutMs?: number;
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

/** The list of started {@link RunningWorker} handles (the single handle `ThinWorkerBootstrap`
 *  starts), closed on shutdown. */
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
 * Discovers every `@Step` method and registers it as a step handler on the thin
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
 * Starts ONE `runRedisWorker` call on bootstrap — after both registrars have run, so every handler
 * is registered before any task is consumed — and closes it on shutdown. The runner (`@dudousxd/
 * durable-worker`) derives its subscription from `runtime.registeredNames()` (one queue per
 * registered `@Workflow`/`@Step` name), not a hand-declared group list. The only runtime side effect
 * of a thin worker: register handlers, run the consumer. No engine, no store, no recovery, no
 * timers, no dispatch.
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
    // ONE call: the runner (Task 5) subscribes one queue per name registered on `this.runtime` —
    // populated by `ThinWorkflowRegistrar`/`ThinStepRegistrar`'s `onModuleInit`, which Nest's
    // lifecycle guarantees run (across the whole app) before any `onApplicationBootstrap` hook.
    const partition = this.options.partition ?? this.options.tenant;
    const handle = await this.runRedisWorker({
      runtime: this.runtime,
      ...(partition !== undefined ? { partition } : {}),
      connection: this.options.connection,
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      ...(this.options.instanceId !== undefined ? { instanceId: this.options.instanceId } : {}),
      ...(this.options.concurrency !== undefined ? { concurrency: this.options.concurrency } : {}),
    });
    this.runners.push(handle);
    this.runnersSink.push(handle);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.runners.map((h) => h.close()));
  }
}

/**
 * A NestJS dynamic module that turns an app into a **PURE durable worker**: it discovers
 * `@Workflow`/`@Step` providers, registers them on the thin {@link DurableWorkerRuntime}, and starts
 * ONE `runRedisWorker` call that subscribes one BullMQ consumer PER REGISTERED NAME — handler
 * discovery IS the subscription surface, not a hand-declared `groups` list. It is
 * **control-plane-less** — it binds
 * NO store/ORM, NO dashboard, NO timer poller, NO recovery, and drives NO runs. The one thing it
 * DOES bind under the `WorkflowEngine` token is a store-less {@link DurableStartClient} facade, so a
 * tenant calls `engine.start(...)` UNCHANGED and it transparently dispatches a start-run to the
 * control plane instead of touching a DB. `cancel`/`deleteRun`/`resume`/… on that facade throw a
 * clear tenant error (the operator owns those).
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
      global: true,
      imports: [DiscoveryModule],
      providers: [
        optionsProvider,
        {
          provide: DurableWorkerRuntime,
          // The runtime's `WorkflowWorker` falls back to its own `group` ctor param as the
          // WORKFLOW's `workflowPartition` for any `ctx.remote` call that omits an explicit
          // `partition` (see `workflow-context.ts`'s `resolveCallGroup`) — that fallback MUST equal
          // this module's own {@link DurableWorkerModuleOptions.partition}, or an implicit-partition
          // remote step's decision carries a mismatched token and the engine dispatches it to a
          // queue nothing here subscribes to. Explicit `''` (never `undefined`) so it does NOT fall
          // through to `WorkflowWorker`'s unrelated `'workflows'` default parameter.
          useFactory: (options: DurableWorkerModuleOptions) =>
            new DurableWorkerRuntime({
              workflowGroup: options.partition ?? options.tenant ?? '',
            }),
          inject: [DURABLE_WORKER_OPTIONS],
        },
        { provide: RUN_REDIS_WORKER, useValue: defaultRunRedisWorker },
        { provide: DURABLE_WORKER_RUNNERS, useValue: [] as RunningWorker[] },
        ThinWorkflowRegistrar,
        ThinStepRegistrar,
        ThinWorkerBootstrap,
        {
          provide: WorkflowEngine,
          useFactory: (options: DurableWorkerModuleOptions) => new DurableStartClient(options),
          inject: [DURABLE_WORKER_OPTIONS],
        },
        {
          provide: RUN_GATEWAY,
          useFactory: (options: DurableWorkerModuleOptions): RunGateway =>
            options.transport
              ? new ProxyRunGateway(
                  options.transport,
                  options.partition ?? options.tenant ?? 'default',
                  options.runGatewayTimeoutMs,
                )
              : unavailableRunGateway(),
          inject: [DURABLE_WORKER_OPTIONS],
        },
        WorkflowService,
      ],
      exports: [DurableWorkerRuntime, WorkflowEngine, WorkflowService, RUN_GATEWAY],
    };
  }
}

/** Reject with a clear, named tenant error for a `RunGateway` call made without a `transport`. The
 *  call site pins `T` from its own declared return type (e.g. `Promise<RunDetail | null>`); this
 *  helper only ever rejects, so it never actually produces a `T` value. */
function tenantGatewayUnavailable<T>(method: string): Promise<T> {
  return Promise.reject(
    new Error(
      `RunGateway.${method}() is not available — pass \`transport\` in DurableWorkerModuleOptions to use RunGateway.`,
    ),
  );
}

/**
 * The no-transport fallback bound to {@link RUN_GATEWAY} when `DurableWorkerModuleOptions.transport`
 * is absent — mirrors `DurableStartClient`'s tenant-error idiom (`tenantUnsupported`): every method
 * rejects with a clear, named error instead of a cryptic `this.gateway.X is not a function`.
 * `subscribe` is synchronous on the `RunGateway` port, so it throws synchronously (same message)
 * rather than returning a rejected promise.
 */
function unavailableRunGateway(): RunGateway {
  return {
    getRunDetail(_runId: string): Promise<RunDetail | null> {
      return tenantGatewayUnavailable<RunDetail | null>('getRunDetail');
    },
    listRuns(_query: RunQuery): Promise<WorkflowRun[]> {
      return tenantGatewayUnavailable<WorkflowRun[]>('listRuns');
    },
    cancel(_runId: string): Promise<RunResult | null> {
      return tenantGatewayUnavailable<RunResult | null>('cancel');
    },
    retry(_runId: string): Promise<RunResult | null> {
      return tenantGatewayUnavailable<RunResult | null>('retry');
    },
    continue(_runId: string): Promise<RunResult | null> {
      return tenantGatewayUnavailable<RunResult | null>('continue');
    },
    retryWithInput(_runId: string, _input: unknown): Promise<{ runId: string } | null> {
      return tenantGatewayUnavailable<{ runId: string } | null>('retryWithInput');
    },
    subscribe(_runId: string, _onEvent: (event: EngineEvent) => void): () => void {
      throw new Error(
        'RunGateway.subscribe() is not available — pass `transport` in DurableWorkerModuleOptions to use RunGateway.',
      );
    },
  };
}
