import {
  DurableWorkerRuntime,
  type RunningWorker,
  runRedisWorker as defaultRunRedisWorker,
} from '@dudousxd/durable-worker';
import {
  DURABLE_OPTIONS_CANONICAL,
  RemoteWorkflowExecutor,
  TRANSPORT_CANONICAL,
  type Transport,
  type WorkflowExecutor,
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

/**
 * Opt-in config for an **in-app worker**: the same NestJS process runs the engine AND serves its own
 * discovered `@Workflow`/`@DurableStep` on one default `group`. The engine registers each `@Workflow`
 * GROUP-SERVED (its turns are dispatched to `group` over the transport via a {@link RemoteWorkflowExecutor}
 * instead of run inline), and a co-located {@link DurableWorkerRuntime} consumes `group` and replays the
 * very same TS bodies. This is the uniform-dispatch "one app, both roles" shape — every turn pays a
 * transport round-trip even though the worker is the same process. Requires a transport that carries
 * workflow tasks (BullMQ); an in-process-only transport cannot dispatch a {@link WorkflowExecutor}.
 */
export interface DurableInAppWorkerOptions {
  /** The default group this app dispatches its `@Workflow` turns to AND consumes as a worker. */
  group: string;
  /** ioredis connection (string or options) for the co-located worker consumer (`runRedisWorker`). */
  connection: string | Record<string, unknown>;
  /** Key prefix namespacing the durable queues. Defaults to `durable` (matches the transport). */
  prefix?: string;
  /** Stable id for this worker process in heartbeats/control. Defaults to a per-host/pid id. */
  instanceId?: string;
  /**
   * How many tasks the co-located worker runs concurrently from its group's queue (BullMQ Worker
   * concurrency). Defaults to 1. Raise it so a fanned-out batch (e.g. the N remote steps of a
   * `gather`) runs in parallel. Per process; total parallelism is `concurrency × replicas`.
   */
  concurrency?: number;
}

/** The resolved {@link DurableInAppWorkerOptions} or `null` when the app didn't opt in. */
export const IN_APP_WORKER_OPTIONS = Symbol('nestjs-durable:in-app-worker-options');

/**
 * The group-served binding the {@link import('./workflow.registrar').WorkflowRegistrar} applies to every
 * discovered `@Workflow`: `{ group, executor }` when the app opted into an in-app worker, else `null`
 * (workflows register inline — the unchanged default). The executor is a {@link RemoteWorkflowExecutor}
 * over the engine's own transport, so a group-served turn is dispatched to `group` and the co-located
 * worker (below) advances it.
 */
export const IN_APP_WORKER_BINDING = Symbol('nestjs-durable:in-app-worker-binding');

/** The co-located worker's {@link DurableWorkerRuntime} (the consumer half). */
export const IN_APP_WORKER_RUNTIME = Symbol('nestjs-durable:in-app-worker-runtime');

/** `runRedisWorker`, injected so tests can substitute a fake (no real Redis). Defaults to the real one. */
export const IN_APP_RUN_REDIS_WORKER = Symbol('nestjs-durable:in-app-run-redis-worker');

/** Started {@link RunningWorker} handles for the in-app group(s), closed on shutdown. */
export const IN_APP_WORKER_RUNNERS = Symbol('nestjs-durable:in-app-worker-runners');

/** The group-served binding shape resolved behind {@link IN_APP_WORKER_BINDING}. */
export interface InAppWorkerBinding {
  group: string;
  executor: WorkflowExecutor;
}

/**
 * Builds the {@link IN_APP_WORKER_BINDING}: when `inAppWorker` is set, a {@link RemoteWorkflowExecutor}
 * over the engine's transport bound to the configured group; otherwise `null` (inline default). Fails
 * fast if opted-in but the transport can't carry workflow tasks — a group-served run would otherwise
 * dead-end at dispatch.
 */
function inAppWorkerBinding(
  transport: Transport | null,
  options: DurableInAppWorkerOptions | null,
): InAppWorkerBinding | null {
  if (!options) return null;
  if (!transport?.dispatchWorkflowTask || !transport.onDecision) {
    throw new Error(
      'inAppWorker requires a transport that carries workflow tasks (dispatchWorkflowTask + onDecision), e.g. BullMQTransport. An in-process transport cannot serve a group-served workflow.',
    );
  }
  return { group: options.group, executor: new RemoteWorkflowExecutor(transport, options.group) };
}

/**
 * The consumer half of the in-app worker: on init it registers every discovered `@Workflow`/`@DurableStep`
 * on a {@link DurableWorkerRuntime} (the SAME bodies the engine registered group-served), and on bootstrap
 * it starts one `runRedisWorker` consumer on the configured group, closing it on shutdown. A no-op when
 * the app didn't opt in. Mirrors the thin {@link import('./durable-worker.module').DurableWorkerModule},
 * but co-located with a full engine.
 */
@Injectable()
export class InAppWorkerBootstrap
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly runners: RunningWorker[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    @Inject(IN_APP_WORKER_OPTIONS) private readonly options: DurableInAppWorkerOptions | null,
    @Inject(IN_APP_WORKER_RUNTIME) private readonly runtime: DurableWorkerRuntime,
    @Inject(IN_APP_RUN_REDIS_WORKER) private readonly runRedisWorker: RunRedisWorkerFn,
    @Inject(IN_APP_WORKER_RUNNERS) private readonly runnersSink: RunningWorker[],
  ) {}

  onModuleInit(): void {
    if (!this.options) return;
    // Register the same TS bodies the engine serves group-served, so the consumer can replay them.
    scanWorkflows(this.discovery, (meta, instance) =>
      this.runtime.registerWorkflow(meta.name, (ctx, input) => instance.run(ctx, input)),
    );
    scanSteps(this.discovery, this.metadataScanner, (meta, handler) =>
      this.runtime.registerStep(meta.name, handler),
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options) return;
    const handle = await this.runRedisWorker({
      runtime: this.runtime,
      group: this.options.group,
      connection: this.options.connection,
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      ...(this.options.instanceId !== undefined ? { instanceId: this.options.instanceId } : {}),
      ...(this.options.concurrency !== undefined ? { concurrency: this.options.concurrency } : {}),
    });
    this.runners.push(handle);
    this.runnersSink.push(handle);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.runners.map((handle) => handle.close()));
  }
}

/**
 * The providers that stand up an in-app worker, added to {@link import('./durable.module').DurableModule}.
 * All are inert when `inAppWorker` is unset (the binding resolves to `null`, the bootstrap no-ops), so a
 * plain `DurableModule` is byte-for-byte unchanged.
 */
export function inAppWorkerProviders(): Provider[] {
  return [
    {
      provide: IN_APP_WORKER_BINDING,
      useFactory: (
        transport: Transport | null,
        options: { inAppWorker?: DurableInAppWorkerOptions },
      ) => inAppWorkerBinding(transport, options.inAppWorker ?? null),
      inject: [TRANSPORT_CANONICAL, DURABLE_OPTIONS_CANONICAL],
    },
    {
      provide: IN_APP_WORKER_OPTIONS,
      useFactory: (options: { inAppWorker?: DurableInAppWorkerOptions }) =>
        options.inAppWorker ?? null,
      inject: [DURABLE_OPTIONS_CANONICAL],
    },
    { provide: IN_APP_WORKER_RUNTIME, useFactory: () => new DurableWorkerRuntime() },
    { provide: IN_APP_RUN_REDIS_WORKER, useValue: defaultRunRedisWorker },
    { provide: IN_APP_WORKER_RUNNERS, useValue: [] as RunningWorker[] },
    InAppWorkerBootstrap,
  ];
}
