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
 * A method carrying its `@Step`-stamped routing name. `ctx.step(ref, input)` reads the name via
 * {@link stepNameOf} — the reference itself is never invoked directly by the caller's process (the
 * worker serving that name re-resolves the real handler from DI), so an unbound `this` on `ref` is
 * irrelevant; `ref` is purely a typed, refactor-safe handle onto the stamped name.
 */
export type StepRef<TInput = unknown, TOutput = unknown> = ((
  input: TInput,
) => Promise<TOutput> | TOutput) & {
  [DURABLE_STEP_NAME]?: string | undefined;
};

/** Read the `@Step`-stamped routing name off a function ref. `undefined` for anything unstamped
 *  (including a plain string — {@link stepNameOf} only reads function refs; a caller passing a
 *  string already has the routing name and dispatches it directly). */
export function stepNameOf(ref: unknown): string | undefined {
  if (typeof ref !== 'function') return undefined;
  const stamped = (ref as { [DURABLE_STEP_NAME]?: unknown })[DURABLE_STEP_NAME];
  return typeof stamped === 'string' ? stamped : undefined;
}
