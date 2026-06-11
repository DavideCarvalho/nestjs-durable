import { type WorkflowCtx, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { getWorkflowMeta } from './decorators';

interface WorkflowInstance {
  run(ctx: WorkflowCtx, input: unknown): Promise<unknown>;
}

/** Scans discovered providers for `@Workflow` classes and registers them with the engine. */
@Injectable()
export class WorkflowRegistrar implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly engine: WorkflowEngine,
  ) {}

  onModuleInit(): void {
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
