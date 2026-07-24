import { AsyncLocalStorage } from 'node:async_hooks';
import type { StepLogger, SubProcessHandle } from './interfaces';

/**
 * The ambient step logger: an `AsyncLocalStorage` the engine installs around every execution of a
 * step body — local (`ctx.step`) and remote (`runStepHandler`) alike — so code running DEEP inside
 * a step can record events without the {@link StepLogger} being threaded through every signature
 * on the way down. The TypeScript twin of the Python SDK's context-local `current_step()`.
 *
 * This is what makes observability symmetric across the two SDKs: in Python a nested helper emits
 * without receiving anything, whereas in TypeScript the logger only ever arrived as the step body's
 * second argument. A generic utility a few layers below the handler (a batch inserter, an HTTP
 * client) can now emit progress without its callers being edited.
 *
 * One storage per PROCESS, not per copy of this package: stashed on `globalThis` under a
 * `Symbol.for` key, so a dependency tree carrying duplicate copies of core still shares the same
 * ambient logger (the same duplicate-copy trap `ambient-ctx.ts` and the DI tokens guard against).
 */
const STORAGE_KEY = Symbol.for('nestjs-durable:ambient-step-logger');

type GlobalWithStorage = typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<StepLogger>;
};

const globalRef = globalThis as GlobalWithStorage;
if (!globalRef[STORAGE_KEY]) {
  globalRef[STORAGE_KEY] = new AsyncLocalStorage<StepLogger>();
}
const storage: AsyncLocalStorage<StepLogger> = globalRef[STORAGE_KEY];

/**
 * Run `fn` with `logger` as the ambient step logger. Engine-internal: wraps every execution of a
 * step body, binding the SAME logger instance the body receives as its second argument — never a
 * second one, so an event emitted ambiently and one emitted through the argument land in the same
 * `StepEvent[]` and are checkpointed together.
 *
 * Because it is an `AsyncLocalStorage`, concurrent step invocations (the worker runs steps under
 * adaptive concurrency) each see their own logger — they never leak into one another.
 */
export function runInStepLogger<T>(logger: StepLogger, fn: () => T): T {
  return storage.run(logger, fn);
}

/**
 * The {@link StepLogger} of the step body currently executing on this async path — or `undefined`
 * outside one. Reading it is the escape hatch for code that cannot take a logger parameter:
 *
 * ```ts
 * currentStep()?.subEvent({ id, name: 'insert', phase: `${rows} rows` });
 * ```
 */
export function currentStep(): StepLogger | undefined {
  return storage.getStore();
}

/**
 * Record a log line on the current step, taking the level as a value. No-op outside a step. The
 * literal twin of the Python SDK's module-level `log(level, message, data)` — keep reaching for it
 * when the level is computed (mapping a foreign log level, re-emitting a captured record); for a
 * level known at the call site the per-level shortcuts below read better.
 *
 * The no-op contract is what lets a generic utility be instrumented without an `if` at the call
 * site, and keeps it usable in a unit test with no durable run around it.
 */
export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
): void {
  currentStep()?.[level](message, data);
}

// The per-level shortcuts, mirroring the same four methods on a `StepLogger` instance so ambient
// code reads exactly like code that was handed the logger — `info('...')` vs `log.info('...')`.
// They are the idiomatic TypeScript form; `log(level, ...)` above is the Python-symmetric one.
// Both are kept: neither subsumes the other (one takes the level as data, the other as a name).

/** Record a `debug` line on the current step. No-op outside a step. */
export function debug(message: string, data?: unknown): void {
  currentStep()?.debug(message, data);
}

/** Record an `info` line on the current step. No-op outside a step. */
export function info(message: string, data?: unknown): void {
  currentStep()?.info(message, data);
}

/** Record a `warn` line on the current step. No-op outside a step. */
export function warn(message: string, data?: unknown): void {
  currentStep()?.warn(message, data);
}

/** Record an `error` line on the current step. No-op outside a step — note this only RECORDS a line;
 *  it never fails the step (that is what throwing from the body does). */
export function error(message: string, data?: unknown): void {
  currentStep()?.error(message, data);
}

/** Record a sub-step / sub-process outcome on the current step. No-op outside a step. */
export function sub(
  name: string,
  status: 'ok' | 'failed' | 'skipped',
  message?: string,
  data?: unknown,
): void {
  currentStep()?.sub(name, status, message, data);
}

/** Record a sub-process event (phase or terminal outcome) on the current step. No-op outside a step. */
export function subEvent(e: {
  id: string;
  name: string;
  group?: string | undefined;
  phase?: string | undefined;
  status?: 'ok' | 'failed' | 'skipped' | undefined;
  message?: string | undefined;
  data?: unknown;
}): void {
  currentStep()?.subEvent(e);
}

// Outside a step there is nothing to emit to, but `subProcess`'s body still has to run and still
// receives a handle — so the same business code takes the same path whether or not it is durable.
const noopSubProcessHandle: SubProcessHandle = {
  phase: () => noopSubProcessHandle,
  skip: () => {},
  fail: () => {},
};

/**
 * Run `body` as a timed sub-process of the current step (see {@link StepLogger.subProcess}).
 * Outside a step the body still RUNS — and still gets a handle — but nothing is emitted; only the
 * observability disappears, never the work. Mirrors the Python SDK's `sub_process`.
 */
export function subProcess<T>(
  name: string,
  body: (sp: SubProcessHandle) => Promise<T> | T,
  opts?: { group?: string; id?: string },
): Promise<T> {
  const logger = currentStep();
  if (!logger) return Promise.resolve(body(noopSubProcessHandle));
  return logger.subProcess(name, body, opts);
}
