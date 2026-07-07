import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowCtx } from './interfaces';

/**
 * The ambient workflow context: an `AsyncLocalStorage` the engine (and the thin worker runtime)
 * installs around every execution of a workflow body, so code running ON the body's async path can
 * discover the live {@link WorkflowCtx} without threading it through — the mechanism behind the
 * class-first `MyWorkflow.start()` / `MyWorkflow.execute()` statics (see `durable-workflow.ts`).
 *
 * One storage per PROCESS, not per copy of this package: stashed on `globalThis` under a
 * `Symbol.for` key, so a dependency tree carrying duplicate copies of core still shares the same
 * ambient context (the same duplicate-copy trap the DI tokens guard against — see `tokens.ts`).
 */
const STORAGE_KEY = Symbol.for('nestjs-durable:ambient-workflow-ctx');

type GlobalWithStorage = typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<WorkflowCtx>;
};

const globalRef = globalThis as GlobalWithStorage;
if (!globalRef[STORAGE_KEY]) {
  globalRef[STORAGE_KEY] = new AsyncLocalStorage<WorkflowCtx>();
}
const storage: AsyncLocalStorage<WorkflowCtx> = globalRef[STORAGE_KEY];

/**
 * Run `fn` with `ctx` as the ambient workflow context. Engine-internal: wraps every execution of a
 * workflow body (first run and every replay), so ambient reads inside the body see the SAME ctx the
 * body received.
 */
export function runInWorkflowCtx<T>(ctx: WorkflowCtx, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The {@link WorkflowCtx} of the workflow body currently executing on this async path — or
 * `undefined` outside one. Note a `@Step` HANDLER runs on a worker, off the body's path: it has no
 * ambient workflow context (by design — a handler is not the workflow body).
 */
export function currentWorkflowCtx(): WorkflowCtx | undefined {
  return storage.getStore();
}
