export * from './attributes-of';
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
// and `WorkflowEngine`/`WorkflowCtx` (core), or `RUN_GATEWAY` (here) and the `RunGateway` class
// (core), no longer require importing both packages to pick up the paired symbol. Additive only —
// re-exports only what already exists on core's public index; core's own new exports (e.g. typed
// search-attribute helpers) are surfaced there, not duplicated here.
//
// Anything in core that is a CLASS — `RunGateway` and `WorkflowEngine` are both abstract classes
// that double as their own DI token — has to be re-exported below as a VALUE. Putting one in the
// `export type` block breaks consumers in a way neither `tsc` nor a build catches: the emitted
// `.d.ts` rollup drops the `type` modifier, so the name type-checks as a value, while the JS
// bundle correctly omits it — `import { RunGateway } from '@dudousxd/nestjs-durable'` compiles
// green and is `undefined` at runtime, and `moduleRef.get(undefined)` fails only on the code path
// that resolves it. Keep classes here, types above.
export type {
  AttributeFilter,
  EngineEvent,
  InferSearchAttributes,
  RunDetail,
  RunListItem,
  RunQuery,
  RunStatus,
  RunWaiting,
  SearchAttributes,
  SearchAttributesSchema,
  StepCheckpoint,
  StepEvent,
  StepLogger,
  WorkflowCtx,
  WorkflowHandler,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
export { readSearchAttributes, RunGateway, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
