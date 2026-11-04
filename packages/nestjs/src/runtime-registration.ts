import type { DurableWorkerRuntime } from '@dudousxd/durable-worker';
import type { MetadataScanner } from '@nestjs/core';
import { type WorkflowMeta, getOnEvents } from './decorators';
import type { WorkflowInstance } from './discovery-helpers';
import { onErrorHandlersOf } from './on-error-handlers';
import { workflowIo } from './workflow-io';

/**
 * Register a `@Workflow` body on a worker runtime with what it ANNOUNCES about it (design §7.9):
 * version, capability demand, declaring package, its onError routes, which the engine applies to a
 * workflow it serves by convention, and the events it subscribes to, which an engine settling a run
 * reads to owe its lifecycle event to a subscriber only this worker has. The `@OnError` handler workflows are registered beside it, so
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
  // The same parse-around-the-body the engine-side registrar applies, so a turn this worker replays
  // sees the parsed input too.
  const body = workflowIo(meta).wrap((ctx, input) => instance.run(ctx, input));
  const subscribes = [
    ...new Set(
      getOnEvents(meta, instance.constructor).map((entry) =>
        typeof entry === 'string' ? entry : entry.event,
      ),
    ),
  ];
  runtime.registerWorkflow(meta.name, body, {
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
    ...(subscribes.length > 0 ? { subscribes } : {}),
  });
  for (const [name, fn] of handlers) runtime.registerWorkflow(name, fn, announced);
}
