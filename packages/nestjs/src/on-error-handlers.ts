import { type OnErrorRoute, type WorkflowCtx, workflowName } from '@dudousxd/nestjs-durable-core';
import type { MetadataScanner } from '@nestjs/core';
import { type WorkflowMeta, onErrorCodesOf } from './decorators';

type WorkflowFn = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

/**
 * A `@Workflow` instance's onError routes and the handler workflows they name. Each `@OnError`
 * method becomes the workflow `<workflow>.onError.<method>`, bound to the instance, with one route per
 * code it declares; `@Workflow({ onError })` adds routes to workflows registered elsewhere.
 *
 * Shared by every registrar: the engine registers the handlers and the routes, and a worker runtime
 * registers the handlers and announces the routes, so a workflow served by convention is routed the
 * same as one the engine registered.
 */
export function onErrorHandlersOf(
  meta: WorkflowMeta,
  instance: object,
  scanner: MetadataScanner,
): { handlers: [string, WorkflowFn][]; routes: OnErrorRoute[] } {
  const handlers: [string, WorkflowFn][] = [];
  const routes: OnErrorRoute[] = [];
  for (const methodName of scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
    const method = (instance as Record<string, unknown>)[methodName];
    const codes = typeof method === 'function' ? onErrorCodesOf(method) : undefined;
    if (!codes) continue;
    const name = `${meta.name}.onError.${methodName}`;
    handlers.push([name, (ctx, input) => (method as WorkflowFn).call(instance, ctx, input)]);
    for (const code of codes) routes.push({ code, workflow: name });
  }
  for (const r of meta.onError ?? []) {
    routes.push({
      code: r.code === undefined || typeof r.code === 'string' ? r.code : r.code.code,
      workflow: workflowName(r.workflow),
    });
  }
  return { handlers, routes };
}
