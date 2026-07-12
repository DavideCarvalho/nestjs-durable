/**
 * Cross-package, cross-runtime marker for engine CONTROL-FLOW signals — {@link WorkflowSuspended}
 * and {@link ContinueAsNew} (this package), plus the thin worker's {@link
 * import('@dudousxd/durable-worker').Suspend} (`@dudousxd/durable-worker`, the BullMQ
 * route-by-handler runtime). These are thrown by `WorkflowCtx`/`WorkflowContext` ops to unwind the
 * current turn — never real failures — so a workflow's `catch` block MUST rethrow them untouched.
 * Running a failure/cleanup path on a control-flow signal corrupts the run: it emits extra
 * `recordStep` commands into history that a subsequent replay didn't produce the first time,
 * surfacing as a `NonDeterminismError`/`NondeterminismError` on resume.
 *
 * `Symbol.for` (the GLOBAL registry), NOT a plain `Symbol()` — so a duplicate copy of this module
 * (pnpm peer-dependency multiplexing, a dual ESM/CJS load, or the SEPARATE `@dudousxd/durable-worker`
 * package declaring the same `Symbol.for` key locally) still collapses onto the SAME symbol. Same
 * rationale as `DURABLE_STEP_NAME` in `./step-name-symbol.ts`.
 *
 * Deliberately checked as a stamped property, NOT `instanceof` — `instanceof` only recognizes a
 * signal thrown by the SAME class the checking code imported, which fails across the in-process
 * engine (`@dudousxd/nestjs-durable-core`'s `WorkflowSuspended`/`ContinueAsNew`) and the thin worker
 * (`@dudousxd/durable-worker`'s `Suspend`) — two different classes for what is, from a workflow
 * author's catch block, the same "this isn't a real error, let it through" event.
 *
 * NOT designed to survive a serialization boundary (e.g. JSON over the wire) — these signals are
 * always thrown and caught in-process within a single replay turn, never (de)serialized, so a
 * stamped-but-not-cloneable property is sufficient.
 */
export const CONTROL_FLOW_SIGNAL = Symbol.for('aviary:durable:control-flow');

/**
 * True for any engine control-flow signal (currently: {@link WorkflowSuspended}, {@link
 * ContinueAsNew}, and the thin worker's `Suspend`) — regardless of which runtime or module instance
 * threw it. Workflow `catch` blocks MUST rethrow these untouched; running a failure/cleanup path on
 * one corrupts the run's history (extra commands recorded during what replay will later see as a
 * suspend, not a failure) and the resumed replay dies with a non-determinism error.
 *
 * Deliberately NOT control-flow (do not add to this predicate):
 * - `Cancelled` (worker) / a cancelled run — a TERMINAL outcome the consumer may legitimately want
 *   to observe and react to (e.g. release a lock), not a mid-turn unwind to rethrow untouched.
 * - `StepFailed` (worker) / an awaited step rejection reaching the engine — a REAL failure a
 *   workflow's `catch` is meant to compensate for; misclassifying it as control-flow would swallow
 *   genuine errors instead of protecting them.
 *
 * @example
 * ```ts
 * try {
 *   await ctx.step('chargeCard', input);
 * } catch (error) {
 *   if (isWorkflowControlFlowSignal(error)) throw error; // suspend/continue-as-new: rethrow as-is
 *   await ctx.step('refund', input); // a REAL failure — safe to run cleanup here
 *   throw error;
 * }
 * ```
 */
export function isWorkflowControlFlowSignal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { [CONTROL_FLOW_SIGNAL]?: unknown })[CONTROL_FLOW_SIGNAL] === true
  );
}
