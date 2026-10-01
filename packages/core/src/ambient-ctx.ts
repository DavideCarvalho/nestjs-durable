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

/**
 * The ambient STEP scope: which workflow ctx's checkpointed step body (if any) is executing on this
 * async path. The engine installs it around every in-body step execution (`ctx.localStep`,
 * `ctx.transaction`, and everything built on them) so the ctx primitives can refuse to run from
 * inside a step body — see {@link NestedWorkflowCallError}. `owner` is the identity of the ctx whose
 * step is running, so a DIFFERENT run's body executed inline from a step (e.g. a step that signals a
 * run which resumes on this async path) is never mistaken for a nested call.
 *
 * Shared per process under a `Symbol.for` key, for the same duplicate-copy reason as the ctx storage.
 */
export interface StepScope {
  readonly owner: object;
  readonly step: string;
}

const STEP_SCOPE_KEY = Symbol.for('nestjs-durable:ambient-step-scope');
type GlobalWithStepScope = typeof globalThis & {
  [STEP_SCOPE_KEY]?: AsyncLocalStorage<StepScope>;
};
const stepScopeRef = globalThis as GlobalWithStepScope;
if (!stepScopeRef[STEP_SCOPE_KEY]) {
  stepScopeRef[STEP_SCOPE_KEY] = new AsyncLocalStorage<StepScope>();
}
const stepScopeStorage: AsyncLocalStorage<StepScope> = stepScopeRef[STEP_SCOPE_KEY];

/** Run `fn` as the body of step `step` of the ctx identified by `owner`. Engine-internal. */
export function runInStepScope<T>(owner: object, step: string, fn: () => T): T {
  return stepScopeStorage.run({ owner, step }, fn);
}

/** The step body currently executing on this async path, or `undefined` outside one. */
export function currentStepScope(): StepScope | undefined {
  return stepScopeStorage.getStore();
}

/**
 * Run `fn` with NO ambient workflow ctx and no step scope — for a dispatched `@Step` handler. A
 * handler is not the workflow body (on a remote worker it never sees one), but an in-process
 * transport invokes it on the body's async path, where the parent's ctx would otherwise leak in and
 * turn a handler's `MyWorkflow.start()` into a journal-corrupting `ctx.startChild` of a parent that
 * is already suspended. Clearing it makes in-process and remote handlers behave identically.
 */
export function runOutsideWorkflowCtx<T>(fn: () => T): T {
  return storage.exit(() => stepScopeStorage.exit(fn));
}
