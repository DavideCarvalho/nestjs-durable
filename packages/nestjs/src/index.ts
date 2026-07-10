export * from './context-accessor';
export * from './decorators';
export { DurableStartClient } from './durable-start-client';
export * from './durable-worker.module';
export * from './durable.module';
export * from './entity';
export * from './in-app-worker';
export * from './proxy-run-gateway';
export * from './role';
export * from './run-request-responder';
export * from './step-interceptor';
export * from './store-run-gateway';
export * from './tenant-event-republisher';
export * from './tokens';
export * from './workflow.service';

// Facade re-exports: the everyday `@dudousxd/nestjs-durable-core` surface a consumer touches
// alongside this package's own decorators/module/tokens, so e.g. the `Workflow` decorator (here)
// and `WorkflowEngine`/`WorkflowCtx` (core), or `RUN_GATEWAY` (here) and its `RunGateway` type
// (core), no longer require importing both packages to pick up the paired symbol. Additive only —
// re-exports only what already exists on core's public index; core's own new exports (e.g. typed
// search-attribute helpers) are surfaced there, not duplicated here.
export type {
  AttributeFilter,
  EngineEvent,
  RunDetail,
  RunGateway,
  RunListItem,
  RunQuery,
  RunStatus,
  RunWaiting,
  SearchAttributes,
  StepCheckpoint,
  StepLogger,
  WorkflowCtx,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
export { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
