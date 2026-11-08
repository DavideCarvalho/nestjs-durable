import { RunGateway } from '@dudousxd/nestjs-durable-core';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { WorkflowsRunGateway } from './workflows-run-gateway';

export {
  toEngineEvent,
  toTimeline,
  toWorkflowRun,
  WORKFLOWS_LIST_CAP,
  WorkflowsRunGateway,
} from './workflows-run-gateway';

/**
 * Binds durable's `RunGateway` to the official `@nestjs/workflows` engine, so
 * `DurableDashboardModule.forRoot(...)` shows its instances. Import it next to `WorkflowsModule`
 * (global, which provides `WorkflowClient` and `WorkflowEvents`) and the dashboard.
 */
@Global()
@Module({})
export class DurableWorkflowsGatewayModule {
  static forRoot(): DynamicModule {
    return {
      module: DurableWorkflowsGatewayModule,
      providers: [WorkflowsRunGateway, { provide: RunGateway, useExisting: WorkflowsRunGateway }],
      exports: [RunGateway, WorkflowsRunGateway],
    };
  }
}
