import type {
  DurableWorkerRuntime,
  RunRedisWorkerOptions,
  RunningWorker,
} from '@dudousxd/durable-worker';
import {
  type AnnouncedSchedule,
  DURABLE_OPTIONS_CANONICAL,
  type DurableTopology,
  type EngineEvent,
  type GroupHealth,
  type RunDetail,
  type RunFacetQuery,
  type RunFacetRow,
  type RunGateway,
  type RunListItem,
  type RunQuery,
  type RunResult,
  type RunValueAxis,
  type RunValueFacetOptions,
  type RunValueFacetRow,
  type RunWaiting,
  type ScheduleAnnouncement,
  type ScheduledWorkflow,
  type TenantTokenSource,
  WorkflowEngine,
  type WorkflowStartClient,
  bindWorkflowClass,
  resolveTenantToken,
  workflowName,
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
import type { DurableModuleOptions, ResolvedTenantAuth } from './durable.module';
import { registerOnRuntime } from './runtime-registration';
import { TENANT_AUTH } from './tokens';
import { createWorkerRuntime, runRedisWorker as defaultRunRedisWorker } from './worker-sdk';

/**
 * The `runRedisWorker` function the module uses to start each partition's BullMQ consumer.
 * Defaults to the real one from `@dudousxd/durable-worker`; tests `overrideProvider` it with a
 * fake so no real Redis is needed.
 */
export const RUN_REDIS_WORKER = Symbol('nestjs-durable:run-redis-worker');

/**
 * The store-less {@link DurableWorkerRuntime} a pure thin worker registers its bodies on — `null` in
 * every other role. A Symbol rather than the class itself: the class lives in an optional peer, and
 * using it as a DI token would drag that peer into the package's static import graph.
 */
export const DURABLE_WORKER_RUNTIME = Symbol('nestjs-durable:worker-runtime');

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
    private readonly metadataScanner: MetadataScanner,
    @Inject(DURABLE_WORKER_RUNTIME) private readonly runtime: DurableWorkerRuntime | null,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
    /** In this role the store-less `DurableStartClient` facade the module binds under this token. */
    @Inject(WorkflowEngine) private readonly starter: WorkflowStartClient,
  ) {}

  onModuleInit(): void {
    const runtime = this.runtime;
    if (runtime === null || !isPureThinWorker(this.options)) return;
    const starter = this.starter;
    // The `@Workflow` metadata is also what this worker ANNOUNCES about each body it serves (design
    // §7.9) — version, capability demand, and the declaring package `scanWorkflows` derived. It is
    // passed straight through: the registry states what the decorator states, and an option the
    // decorator left off stays un-stated rather than becoming a default.
    scanWorkflows(this.discovery, (meta, instance, origin) => {
      registerOnRuntime(runtime, this.metadataScanner, meta, instance, origin);
      // Class-first statics (`MyWorkflow.start()`), as on an operator: bound to the start facade, so
      // they publish a start-run message to the control plane. `waitForRun` stays unbound (a tenant
      // has no store), so `MyWorkflow.execute()` outside a workflow fails with a clear error.
      bindWorkflowClass(instance.constructor, {
        start: (name, input, runId, opts) => starter.start(name, input, runId, opts),
      });
    });
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
    @Inject(DURABLE_WORKER_RUNTIME) private readonly runtime: DurableWorkerRuntime | null,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
  ) {}

  onModuleInit(): void {
    const runtime = this.runtime;
    if (runtime === null || !isPureThinWorker(this.options)) return;
    scanSteps(this.discovery, this.metadataScanner, (meta, handler) =>
      runtime.registerStep(meta.name, handler),
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
    @Inject(DURABLE_WORKER_RUNTIME) private readonly runtime: DurableWorkerRuntime | null,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
    @Inject(RUN_REDIS_WORKER) private readonly runRedisWorker: RunRedisWorkerFn,
    @Inject(DURABLE_WORKER_RUNNERS) private readonly runnersSink: RunningWorker[],
    @Inject(TENANT_AUTH) private readonly auth: ResolvedTenantAuth,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const options = this.options;
    const runtime = this.runtime;
    if (runtime === null || !isPureThinWorker(options) || options.connection === undefined) return;
    // `consumers: false`: a producer-only process (CLI, REPL, script) starts no consumer.
    if (options.consumers === false) {
      if ((options.schedules?.length ?? 0) > 0) {
        console.warn(
          '[nestjs-durable] `schedules` on a tenant with `consumers: false` are not announced: a tenant announces its schedules on its worker descriptor, so declare them on the processes that run its workers.',
        );
      }
      return;
    }
    // ONE call: the runner subscribes one queue per name registered on `runtime` — populated by
    // `ThinWorkflowRegistrar`/`ThinStepRegistrar`'s `onModuleInit`, which Nest's lifecycle guarantees
    // run (across the whole app) before any `onApplicationBootstrap` hook.
    const handle = await this.runRedisWorker({
      runtime,
      connection: options.connection,
      ...(options.partition !== undefined ? { partition: options.partition } : {}),
      ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
      ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      // Announce the app's schedules (an empty list too) so the control plane adopts, updates and
      // withdraws them: a tenant has no store to fire them from.
      ...(await tenantScheduleAnnouncement(options, this.auth.tenantToken)),
    });
    this.runners.push(handle);
    this.runnersSink.push(handle);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.runners.map((h) => h.close()));
  }
}

/**
 * The tenant's `schedules`, as its worker announces them: under the wire tenant its starts carry (the
 * signed token when the app has one, else the partition), one {@link AnnouncedSchedule} per schedule.
 * A schedule's `namespace` is dropped (a tenant's runs always belong to its own namespace), and
 * `backfill` becomes the control plane's `catchup: 'latest'` (at most one late window).
 */
export async function tenantScheduleAnnouncement(
  options: DurableModuleOptions,
  tenantToken: TenantTokenSource | undefined,
): Promise<{ schedules?: ScheduleAnnouncement }> {
  let tenant: string;
  try {
    tenant =
      tenantToken !== undefined
        ? await resolveTenantToken(tenantToken)
        : (options.partition ?? 'default');
  } catch (error) {
    // A token source that fails at boot must not keep the worker from starting: it announces no
    // schedules (the control plane then neither adopts nor withdraws any for it) and says so.
    console.warn(
      `[nestjs-durable] this worker announces no schedules: its tenantToken failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return {};
  }
  return { schedules: { tenant, items: (options.schedules ?? []).map(announcedSchedule) } };
}

function announcedSchedule(s: ScheduledWorkflow): AnnouncedSchedule {
  const item: AnnouncedSchedule = { key: s.key, workflow: workflowName(s.workflow) };
  if (s.input !== undefined) item.input = s.input;
  if (s.everyMs !== undefined) item.everyMs = s.everyMs;
  if (s.cron !== undefined) item.cron = s.cron;
  if (s.timezone !== undefined) item.timezone = s.timezone;
  if (s.paused === true) item.paused = true;
  if (s.overlap !== undefined) item.overlap = s.overlap;
  if (s.jitter !== undefined && s.jitter > 0) item.jitterMs = s.jitter;
  return item;
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
      provide: DURABLE_WORKER_RUNTIME,
      // The runtime's `WorkflowWorker` falls back to its own `group` ctor param as the WORKFLOW's
      // `workflowPartition` for any `ctx.step` call (see `workflow-context.ts`'s `resolveCallGroup`)
      // — that fallback MUST equal this module's own `partition`, or a dispatched step's decision
      // carries a mismatched token and the engine dispatches it to a queue nothing here subscribes
      // to. Explicit `''` (never
      // `undefined`) so it does NOT fall through to `WorkflowWorker`'s unrelated `'workflows'`
      // default parameter.
      //
      // The role gate lives HERE, not just in the consumers: constructing the runtime resolves the
      // optional `@dudousxd/durable-worker` peer, so an operator that never runs a worker must not
      // reach this branch at all.
      useFactory: (options: DurableModuleOptions) =>
        isPureThinWorker(options)
          ? createWorkerRuntime({ workflowGroup: options.partition ?? '' })
          : null,
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
 * The no-transport fallback bound to `RunGateway` for a thin worker (`connection` set, `store`
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
    runFacets(_query: RunFacetQuery): Promise<RunFacetRow[]> {
      return tenantGatewayUnavailable<RunFacetRow[]>('runFacets');
    },
    runValueFacets(
      _axis: RunValueAxis,
      _query: RunFacetQuery,
      _opts?: RunValueFacetOptions,
    ): Promise<RunValueFacetRow[]> {
      return tenantGatewayUnavailable<RunValueFacetRow[]>('runValueFacets');
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
