import {
  DurableWorkerRuntime,
  type RunRedisWorkerOptions,
  type RunningWorker,
  runRedisWorker as defaultRunRedisWorker,
} from '@dudousxd/durable-worker';
import {
  DURABLE_OPTIONS_CANONICAL,
  type DurableTopology,
  type EngineEvent,
  type GroupHealth,
  type RunDetail,
  type RunGateway,
  type RunListItem,
  type RunQuery,
  type RunResult,
  type RunWaiting,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { scanSteps, scanWorkflows } from './discovery-helpers';
import type { DurableModuleOptions } from './durable.module';

/**
 * The `runRedisWorker` function the module uses to start each partition's BullMQ consumer.
 * Defaults to the real one from `@dudousxd/durable-worker`; tests `overrideProvider` it with a
 * fake so no real Redis is needed.
 */
export const RUN_REDIS_WORKER = Symbol('nestjs-durable:run-redis-worker');

/** The list of started {@link RunningWorker} handles (the single handle {@link ThinWorkerBootstrap}
 *  starts), closed on shutdown. */
export const DURABLE_WORKER_RUNNERS = Symbol('nestjs-durable:worker-runners');

/** The signature of `runRedisWorker` — injected behind {@link RUN_REDIS_WORKER}. */
export type RunRedisWorkerFn = (opts: RunRedisWorkerOptions) => Promise<RunningWorker>;

/** True for the **pure thin-worker** role — `connection` set, `store` unset. `DurableModule`
 *  keeps {@link ThinWorkflowRegistrar}/{@link ThinStepRegistrar}/{@link ThinWorkerBootstrap} inert
 *  (registered but no-op) outside this role — an operator (`store` set) drives its own bodies
 *  inline or, with `connection` also set, through the separate in-app-worker mechanics instead. */
function isPureThinWorker(options: DurableModuleOptions): boolean {
  return options.store === undefined && options.connection !== undefined;
}

/**
 * Discovers every provider carrying `@Workflow` metadata and registers its `run(ctx, input)` on the
 * thin {@link DurableWorkerRuntime}. Mirrors the engine-side `WorkflowRegistrar`, but registers on
 * the runner-core runtime instead of a `WorkflowEngine` — the runtime drives `run` with the thin
 * `WorkflowContext` (which `implements WorkflowCtx`), so the body runs unchanged. NO store/engine.
 * Inert (skips registration) outside the pure thin-worker role — see {@link isPureThinWorker}.
 */
@Injectable()
export class ThinWorkflowRegistrar implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly runtime: DurableWorkerRuntime,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  onModuleInit(): void {
    if (!isPureThinWorker(this.options)) return;
    // The `@Workflow` metadata is also what this worker ANNOUNCES about each body it serves (design
    // §7.9) — version, capability demand, and the declaring package `scanWorkflows` derived. It is
    // passed straight through: the registry states what the decorator states, and an option the
    // decorator left off stays un-stated rather than becoming a default.
    scanWorkflows(this.discovery, (meta, instance, origin) =>
      this.runtime.registerWorkflow(meta.name, (ctx, input) => instance.run(ctx, input), {
        version: meta.version,
        ...(meta.requires !== undefined ? { requires: meta.requires } : {}),
        ...(origin !== undefined ? { origin } : {}),
      }),
    );
  }
}

/**
 * Discovers every `@Step` method and registers it as a step handler on the thin
 * {@link DurableWorkerRuntime}. Mirrors the engine-side `DurableStepRegistrar`, but always registers
 * on the runtime (a thin worker IS the consumer — there is no in-process-vs-queue branch). Inert
 * outside the pure thin-worker role — see {@link isPureThinWorker}.
 */
@Injectable()
export class ThinStepRegistrar implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly runtime: DurableWorkerRuntime,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  onModuleInit(): void {
    if (!isPureThinWorker(this.options)) return;
    scanSteps(this.discovery, this.metadataScanner, (meta, handler) =>
      this.runtime.registerStep(meta.name, handler),
    );
  }
}

/**
 * Starts ONE `runRedisWorker` call on bootstrap — after both registrars have run, so every handler
 * is registered before any task is consumed — and closes it on shutdown. The runner (`@dudousxd/
 * durable-worker`) derives its subscription from `runtime.registeredNames()` (one queue per
 * registered `@Workflow`/`@Step` name), not a hand-declared group list. Inert outside the pure
 * thin-worker role — see {@link isPureThinWorker}: an operator (`store` set) never starts this
 * consumer, and `store + connection` starts its OWN co-located consumer instead (`in-app-worker.ts`).
 *
 * For the shutdown close to fire, enable Nest's shutdown hooks: `app.enableShutdownHooks()`.
 */
@Injectable()
export class ThinWorkerBootstrap implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly runners: RunningWorker[] = [];

  constructor(
    private readonly runtime: DurableWorkerRuntime,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
    @Inject(RUN_REDIS_WORKER) private readonly runRedisWorker: RunRedisWorkerFn,
    @Inject(DURABLE_WORKER_RUNNERS) private readonly runnersSink: RunningWorker[],
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const options = this.options;
    if (!isPureThinWorker(options) || options.connection === undefined) return;
    // ONE call: the runner subscribes one queue per name registered on `this.runtime` — populated by
    // `ThinWorkflowRegistrar`/`ThinStepRegistrar`'s `onModuleInit`, which Nest's lifecycle guarantees
    // run (across the whole app) before any `onApplicationBootstrap` hook.
    const handle = await this.runRedisWorker({
      runtime: this.runtime,
      connection: options.connection,
      ...(options.partition !== undefined ? { partition: options.partition } : {}),
      ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
      ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    });
    this.runners.push(handle);
    this.runnersSink.push(handle);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.runners.map((h) => h.close()));
  }
}

/**
 * The thin-worker slice of {@link import('./durable.module').DurableModule}'s unified provider set —
 * active for the pure thin-worker role (`connection` set, `store` unset): registers discovered
 * `@Workflow`/`@Step` on a store-less {@link DurableWorkerRuntime} and starts ONE `runRedisWorker`
 * consumer, one queue PER REGISTERED NAME. Always present in the provider list (so a single
 * `DurableModule.forRootAsync` can serve any role once its options resolve); every class/factory here
 * is inert (see {@link isPureThinWorker}) outside that role.
 */
export function thinWorkerProviders(): Provider[] {
  return [
    {
      provide: DurableWorkerRuntime,
      // The runtime's `WorkflowWorker` falls back to its own `group` ctor param as the WORKFLOW's
      // `workflowPartition` for any `ctx.step` call (see `workflow-context.ts`'s `resolveCallGroup`)
      // — that fallback MUST equal this module's own `partition`, or a dispatched step's decision
      // carries a mismatched token and the engine dispatches it to a queue nothing here subscribes
      // to. Explicit `''` (never
      // `undefined`) so it does NOT fall through to `WorkflowWorker`'s unrelated `'workflows'`
      // default parameter.
      useFactory: (options: DurableModuleOptions) =>
        new DurableWorkerRuntime({ workflowGroup: options.partition ?? '' }),
      inject: [DURABLE_OPTIONS_CANONICAL],
    },
    { provide: RUN_REDIS_WORKER, useValue: defaultRunRedisWorker },
    { provide: DURABLE_WORKER_RUNNERS, useValue: [] as RunningWorker[] },
    ThinWorkflowRegistrar,
    ThinStepRegistrar,
    ThinWorkerBootstrap,
  ];
}

/** Reject with a clear, named tenant error for a `RunGateway` call made without a `transport`. The
 *  call site pins `T` from its own declared return type (e.g. `Promise<RunDetail | null>`); this
 *  helper only ever rejects, so it never actually produces a `T` value. */
function tenantGatewayUnavailable<T>(method: string): Promise<T> {
  return Promise.reject(
    new Error(`RunGateway.${method}() is not available — pass \`transport\` to use RunGateway.`),
  );
}

/**
 * The no-transport fallback bound to `RUN_GATEWAY` for a thin worker (`connection` set, `store`
 * unset) that didn't also pass a `transport` — mirrors `DurableStartClient`'s tenant-error idiom
 * (`tenantUnsupported`): every method rejects with a clear, named error instead of a cryptic
 * `this.gateway.X is not a function`. `subscribe` is synchronous on the `RunGateway` port, so it
 * throws synchronously (same message) rather than returning a rejected promise.
 */
export function unavailableRunGateway(): RunGateway {
  return {
    // Topology is local metadata, always answerable — a thin worker with no transport is still a tenant.
    topology(): DurableTopology {
      return { role: 'tenant' };
    },
    getRunDetail(_runId: string): Promise<RunDetail | null> {
      return tenantGatewayUnavailable<RunDetail | null>('getRunDetail');
    },
    listRuns(_query: RunQuery): Promise<RunListItem[]> {
      return tenantGatewayUnavailable<RunListItem[]>('listRuns');
    },
    waitingFor(_runIds: string[]): Promise<Record<string, RunWaiting>> {
      return tenantGatewayUnavailable<Record<string, RunWaiting>>('waitingFor');
    },
    workerHealth(): Promise<GroupHealth[]> {
      return tenantGatewayUnavailable<GroupHealth[]>('workerHealth');
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
    redispatchPending(_runId: string): Promise<(RunResult & { redispatched: number }) | null> {
      return tenantGatewayUnavailable<(RunResult & { redispatched: number }) | null>(
        'redispatchPending',
      );
    },
    subscribe(_runId: string, _onEvent: (event: EngineEvent) => void): () => void {
      throw new Error(
        'RunGateway.subscribe() is not available — pass `transport` to use RunGateway.',
      );
    },
  };
}
