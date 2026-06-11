import {
  DURABLE_OPTIONS,
  STATE_STORE,
  type StateStore,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { getWorkflowMeta } from './decorators';
import type { DurableModuleOptions } from './durable.module';

interface WorkflowInstance {
  run(ctx: WorkflowCtx, input: unknown): Promise<unknown>;
}

/**
 * Ensures the schema (auto-schema) and registers `@Workflow` providers on init, then resumes
 * runs left incomplete by a previous process once the application has booted.
 */
@Injectable()
export class WorkflowRegistrar implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly engine: WorkflowEngine,
    @Inject(STATE_STORE) private readonly store: StateStore,
    @Inject(DURABLE_OPTIONS) private readonly options: DurableModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.engine.recoverIncomplete();
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
