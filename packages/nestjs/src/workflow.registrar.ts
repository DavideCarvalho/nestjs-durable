import {
  DURABLE_OPTIONS,
  STATE_STORE,
  type StateStore,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { getWorkflowMeta } from './decorators';
import type { DurableModuleOptions } from './durable.module';

interface WorkflowInstance {
  run(ctx: WorkflowCtx, input: unknown): Promise<unknown>;
}

/**
 * Ensures the schema (auto-schema) and registers `@Workflow` providers on init, resumes runs left
 * incomplete by a previous process once booted, and drains in-flight runs on shutdown.
 *
 * For the shutdown drain to fire, enable Nest's shutdown hooks: `app.enableShutdownHooks()`.
 */
@Injectable()
export class WorkflowRegistrar
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly engine: WorkflowEngine,
    @Inject(STATE_STORE) private readonly store: StateStore,
    @Inject(DURABLE_OPTIONS) private readonly options: DurableModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Only the worker role recovers runs left incomplete by a crash/deploy. A dashboard-only
    // instance (`worker: false`) must not pick up and re-run workflows — leave that to the workers.
    if (this.options.worker === false) return;
    await this.engine.recoverIncomplete();
  }

  /** On deploy/shutdown: stop picking up new runs and wait for in-flight ones to settle. */
  async onApplicationShutdown(): Promise<void> {
    await this.engine.drain(this.options.shutdownTimeoutMs);
  }

  async onModuleInit(): Promise<void> {
    if (this.options.autoSchema !== false) {
      await this.store.ensureSchema?.();
    }
    for (const wrapper of this.discovery.getProviders()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;
      const meta = getWorkflowMeta(instance.constructor);
      if (!meta) continue;
      const workflow = instance as WorkflowInstance;
      if (typeof workflow.run !== 'function') {
        throw new Error(`@Workflow ${meta.name} must define a run(ctx, input) method`);
      }
      this.engine.register(meta.name, meta.version, (ctx, input) => workflow.run(ctx, input));
    }
  }
}
