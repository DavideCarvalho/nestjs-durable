/**
 * Cross-package step-name stamp. The `@Step` decorator (`@dudousxd/nestjs-durable`) writes a
 * method's derived routing name under this key; core's `ctx.step` reads it (via {@link stepNameOf})
 * to route a method-reference call to the same handler a worker registers by name.
 *
 * `Symbol.for` (the GLOBAL registry), NOT a plain `Symbol()` — so a duplicate copy of this module
 * (pnpm peer-dependency multiplexing, or a dual ESM/CJS load) still reads the SAME key. A plain
 * `Symbol()` would mint a distinct token per copy, so a decorator running against one core instance
 * could stamp a name core's `ctx.step` (a different instance) can never read back. Mirrors the
 * `STATE_STORE` token fix in `./tokens.ts`.
 */
export const DURABLE_STEP_NAME = Symbol.for('durable.step.name');

/**
 * Cross-package step-DISPATCH-POLICY stamp. `@Step({ retries, backoff, backoffMs, backoffMaxMs,
 * jitter, timeoutMs })` (`@dudousxd/nestjs-durable`) writes the def-level durable-retry/liveness
 * policy under this key; core's `ctx.step` reads it (via {@link stepConfigOf}) and merges it with any
 * per-call {@link StepDispatchOpts} override to build the dispatched {@link StepDef}. Same
 * `Symbol.for` rationale as {@link DURABLE_STEP_NAME} — a duplicate copy of this module (pnpm
 * peer-dependency multiplexing, dual ESM/CJS) must still read back the SAME key.
 */
export const DURABLE_STEP_CONFIG = Symbol.for('durable.step.config');

/**
 * The def-level durable-dispatch policy a `@Step(...)` can stamp on a method: retry/backoff and the
 * remote-liveness `timeoutMs` — the dispatch-relevant subset of the engine's `StepOptions`. Read off
 * a handler reference via {@link stepConfigOf}; a per-call {@link StepDispatchOpts} passed to
 * `ctx.step(ref, input, opts)` overrides these field-by-field.
 */
export interface StepConfig {
  /** Max attempts before the step (and run) fails. */
  retries?: number | undefined;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt). */
  backoff?: 'fixed' | 'exp' | undefined;
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. */
  backoffMs?: number | undefined;
  /** Upper bound on the (exponential) backoff delay. */
  backoffMaxMs?: number | undefined;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. */
  jitter?: boolean | undefined;
  /** Liveness window for the dispatched step: no result/heartbeat within this many ms presumes the
   *  worker dead and fails the dispatch with a `RemoteStepTimeout` (retryable — re-dispatches per
   *  `retries`). Omit to wait indefinitely. */
  timeoutMs?: number | undefined;
  /** Capabilities a live worker must advertise to run this step (handshake design §7.5). The
   *  control-plane routes the step only to capable+compatible workers; if descriptors are published
   *  on its group but none qualifies, the run parks `blocked`. Absent/empty = "runs anywhere". */
  requires?: string[] | undefined;
}

function isStepConfig(value: unknown): value is StepConfig {
  return typeof value === 'object' && value !== null;
}

/**
 * A method carrying its `@Step`-stamped routing name (and, optionally, its dispatch policy).
 * `ctx.step(ref, input)` reads the name via {@link stepNameOf} — the reference itself is never
 * invoked directly by the caller's process (the worker serving that name re-resolves the real
 * handler from DI), so an unbound `this` on `ref` is irrelevant; `ref` is purely a typed,
 * refactor-safe handle onto the stamped name (and policy).
 */
export type StepRef<TInput = unknown, TOutput = unknown> = ((
  input: TInput,
) => Promise<TOutput> | TOutput) & {
  [DURABLE_STEP_NAME]?: string | undefined;
  [DURABLE_STEP_CONFIG]?: StepConfig | undefined;
};

/** Read the `@Step`-stamped routing name off a function ref. `undefined` for anything unstamped
 *  (including a plain string — {@link stepNameOf} only reads function refs; a caller passing a
 *  string already has the routing name and dispatches it directly). */
export function stepNameOf(ref: unknown): string | undefined {
  if (typeof ref !== 'function') return undefined;
  const stamped = (ref as { [DURABLE_STEP_NAME]?: unknown })[DURABLE_STEP_NAME];
  return typeof stamped === 'string' ? stamped : undefined;
}

/** Read the `@Step`-stamped dispatch policy off a function ref. `undefined` for anything unstamped
 *  (including a plain string — a cross-runtime string-name call has no def-level policy to read; pass
 *  it via {@link StepDispatchOpts} instead). */
export function stepConfigOf(ref: unknown): StepConfig | undefined {
  if (typeof ref !== 'function') return undefined;
  const stamped = (ref as { [DURABLE_STEP_CONFIG]?: unknown })[DURABLE_STEP_CONFIG];
  return isStepConfig(stamped) ? stamped : undefined;
}
