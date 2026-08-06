import {
  DurableWorkerRuntime,
  type RunningWorker,
  runRedisWorker as defaultRunRedisWorker,
} from '@dudousxd/durable-worker';
import {
  DURABLE_OPTIONS_CANONICAL,
  TRANSPORT_CANONICAL,
  type Transport,
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
import type { RunRedisWorkerFn } from './durable-worker.module';
import type { DurableModuleOptions } from './durable.module';

/**
 * The **co-located in-app worker** (uniform dispatch): active whenever an app supplies BOTH `store`
 * AND `connection` (`DurableModule.forRoot({ store, transport, connection, partition? })`) — the same
 * process runs the engine AND serves its own discovered `@Workflow`/`@Step`. The engine registers each
 * `@Workflow` GROUP-SERVED — its turns are dispatched, PER WORKFLOW NAME, to
 * `tenantGroup(sanitizeQueueToken(name), partition)` over the transport via a per-workflow
 * `RemoteWorkflowExecutor` instead of run inline — and a co-located {@link DurableWorkerRuntime}
 * subscribes one queue per discovered name (via `runRedisWorker`) and replays the very same TS bodies.
 * This is the uniform-dispatch "one app, both roles" shape — every turn pays a transport round-trip
 * even though the worker is the same process. Requires a transport that carries workflow tasks
 * (BullMQ); an in-process-only transport cannot dispatch a `WorkflowExecutor`.
 *
 * Distinct from the PURE thin-worker role (`connection` set, `store` unset — see
 * `durable-worker.module.ts`'s `ThinWorkflowRegistrar`/`ThinStepRegistrar`/`ThinWorkerBootstrap`),
 * which has no engine/store of its own at all.
 */
export const IN_APP_WORKER_BINDING = Symbol('nestjs-durable:in-app-worker-binding');

/** The co-located worker's {@link DurableWorkerRuntime} (the consumer half). */
export const IN_APP_WORKER_RUNTIME = Symbol('nestjs-durable:in-app-worker-runtime');

/** `runRedisWorker`, injected so tests can substitute a fake (no real Redis). Defaults to the real one. */
export const IN_APP_RUN_REDIS_WORKER = Symbol('nestjs-durable:in-app-run-redis-worker');

/** Started {@link RunningWorker} handles for the in-app worker, closed on shutdown. */
export const IN_APP_WORKER_RUNNERS = Symbol('nestjs-durable:in-app-worker-runners');

/** The group-served binding shape resolved behind {@link IN_APP_WORKER_BINDING}. */
export interface InAppWorkerBinding {
  transport: Transport;
  partition?: string;
}

/** True for the **co-located** role — both `store` AND `connection` set. */
function isCoLocatedWorker(options: DurableModuleOptions): boolean {
  return options.store !== undefined && options.connection !== undefined;
}

/**
 * Builds the {@link IN_APP_WORKER_BINDING}: when this app is co-located (`store` + `connection`), the
 * engine's transport plus the configured partition — the registrar builds a PER-WORKFLOW
 * `RemoteWorkflowExecutor` from these, one per discovered name; otherwise `null` (inline default).
 * Fails fast if co-located but the transport can't carry workflow tasks — a group-served run would
 * otherwise dead-end at dispatch.
 */
function inAppWorkerBinding(
  transport: Transport | null,
  options: DurableModuleOptions,
): InAppWorkerBinding | null {
  if (!isCoLocatedWorker(options)) return null;
  if (!transport?.dispatchWorkflowTask || !transport.onDecision) {
    throw new Error(
      'a co-located worker (store + connection) requires a transport that carries workflow tasks (dispatchWorkflowTask + onDecision), e.g. BullMQTransport. An in-process transport cannot serve a group-served workflow.',
    );
  }
  return {
    transport,
    ...(options.partition !== undefined ? { partition: options.partition } : {}),
  };
}

/**
 * The consumer half of the in-app worker: on init it registers every discovered `@Workflow`/`@Step`
 * on a {@link DurableWorkerRuntime} (the SAME bodies the engine registered group-served), and on
 * bootstrap it starts one `runRedisWorker` call that subscribes one queue per discovered name,
 * suffixed by the configured partition, closing it on shutdown. A no-op outside the co-located role
 * (see {@link isCoLocatedWorker}). Mirrors the thin {@link
 * import('./durable-worker.module').ThinWorkerBootstrap}, but co-located with a full engine.
 */
@Injectable()
export class InAppWorkerBootstrap
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly runners: RunningWorker[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    @Inject(DURABLE_OPTIONS_CANONICAL) private readonly options: DurableModuleOptions,
    @Inject(IN_APP_WORKER_RUNTIME) private readonly runtime: DurableWorkerRuntime,
    @Inject(IN_APP_RUN_REDIS_WORKER) private readonly runRedisWorker: RunRedisWorkerFn,
    @Inject(IN_APP_WORKER_RUNNERS) private readonly runnersSink: RunningWorker[],
  ) {}

  onModuleInit(): void {
    if (!isCoLocatedWorker(this.options)) return;
    // Register the same TS bodies the engine serves group-served, so the consumer can replay them.
    // The metadata rides along as this worker's ANNOUNCEMENT of what it can execute (design §7.9):
    // co-located or not, the process that CONSUMES the queue is the one entitled to announce the
    // workflow, and here that is this runtime — not the engine sharing its process.
    scanWorkflows(this.discovery, (meta, instance, origin) =>
      this.runtime.registerWorkflow(meta.name, (ctx, input) => instance.run(ctx, input), {
        version: meta.version,
        ...(meta.requires !== undefined ? { requires: meta.requires } : {}),
        ...(origin !== undefined ? { origin } : {}),
      }),
    );
    scanSteps(this.discovery, this.metadataScanner, (meta, handler) =>
      this.runtime.registerStep(meta.name, handler),
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    const options = this.options;
    if (!isCoLocatedWorker(options) || options.connection === undefined) return;
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
    await Promise.allSettled(this.runners.map((handle) => handle.close()));
  }
}

/**
 * The providers that stand up the co-located in-app worker, added to {@link
 * import('./durable.module').DurableModule}'s unified provider set. All are inert outside the
 * co-located role (`store` + `connection` both set — see {@link isCoLocatedWorker}), so a plain
 * operator (`store` only) or pure thin worker (`connection` only) is unaffected.
 */
export function inAppWorkerProviders(): Provider[] {
  return [
    {
      provide: IN_APP_WORKER_BINDING,
      useFactory: (transport: Transport | null, options: DurableModuleOptions) =>
        inAppWorkerBinding(transport, options),
      inject: [TRANSPORT_CANONICAL, DURABLE_OPTIONS_CANONICAL],
    },
    {
      provide: IN_APP_WORKER_RUNTIME,
      // The runtime's `WorkflowWorker` uses its `group` ctor param as the WORKFLOW's
      // `workflowPartition` for any `ctx.step` call (see `workflow-context.ts`'s `resolveCallGroup`)
      // — that fallback MUST equal this app's own `partition`, or a dispatched step's decision
      // carries a mismatched token and the engine dispatches it to a queue nothing here subscribes
      // to. Explicit `''` (never
      // `undefined`) so it does NOT fall through to `WorkflowWorker`'s unrelated `'workflows'`
      // default parameter.
      useFactory: (options: DurableModuleOptions) =>
        new DurableWorkerRuntime({ workflowGroup: options.partition ?? '' }),
      inject: [DURABLE_OPTIONS_CANONICAL],
    },
    { provide: IN_APP_RUN_REDIS_WORKER, useValue: defaultRunRedisWorker },
    { provide: IN_APP_WORKER_RUNNERS, useValue: [] as RunningWorker[] },
    InAppWorkerBootstrap,
  ];
}
