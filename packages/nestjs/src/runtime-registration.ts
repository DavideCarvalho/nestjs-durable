import type { DurableWorkerRuntime } from '@dudousxd/durable-worker';
import type { MetadataScanner } from '@nestjs/core';
import type { WorkflowMeta } from './decorators';
import type { WorkflowInstance } from './discovery-helpers';
import { onErrorHandlersOf } from './on-error-handlers';

/**
 * Register a `@Workflow` body on a worker runtime with what it ANNOUNCES about it (design §7.9):
 * version, capability demand, declaring package, and its onError routes, which the engine applies to
 * a workflow it serves by convention. The `@OnError` handler workflows are registered beside it, so
 * the queue the engine dispatches a handler to by name is one this worker consumes.
 */
export function registerOnRuntime(
  runtime: DurableWorkerRuntime,
  scanner: MetadataScanner,
  meta: WorkflowMeta,
  instance: WorkflowInstance,
  origin: string | undefined,
): void {
  const { handlers, routes } = onErrorHandlersOf(meta, instance, scanner);
  const announced = {
    version: meta.version,
    ...(origin !== undefined ? { origin } : {}),
  };
  runtime.registerWorkflow(meta.name, (ctx, input) => instance.run(ctx, input), {
    ...announced,
    ...(meta.requires !== undefined ? { requires: meta.requires } : {}),
    // A catch-all goes on the wire without a `code` key, not with an undefined one.
    ...(routes.length > 0
      ? {
          onError: routes.map(({ code, workflow }) =>
            code === undefined ? { workflow } : { code, workflow },
          ),
        }
      : {}),
  });
  for (const [name, fn] of handlers) runtime.registerWorkflow(name, fn, announced);
}
