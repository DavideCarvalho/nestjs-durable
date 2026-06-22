import type { StepError } from '@dudousxd/nestjs-durable-core';

/** Base for workflow-runtime errors. Mirrors the Python `WorkflowError`. */
export class WorkflowError extends Error {}

/**
 * The history doesn't match what the replay produced at a seq — the workflow code changed under a
 * run that is already in flight. The run fails loudly rather than silently diverging. Mirrors the
 * Python `NondeterminismError`.
 */
export class NondeterminismError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = 'NondeterminismError';
  }
}

/**
 * A step/call/child the workflow awaited resolved to a failure. Catchable in workflow code
 * (`try/catch`) exactly like an awaited rejection — catch it to compensate, or let it propagate to
 * fail the run. Mirrors the Python `StepFailed`.
 */
export class StepFailed extends Error {
  readonly error: StepError;

  constructor(error?: StepError | null) {
    const err: StepError = error ?? { message: 'step failed' };
    super(err.message ?? 'step failed');
    this.name = 'StepFailed';
    this.error = err;
  }
}

/** One failed item in a {@link GatherError}: its input position, the step `name` (gather) or child
 *  `workflow` (all), and the recorded error. Both keys are present so a caller can read whichever
 *  fits the op — mirrors the engine's `GatherError.failures` (index/id/error) and Python's per-item
 *  failure dicts. */
export interface GatherFailure {
  index: number;
  name?: string;
  workflow?: string;
  error: StepError;
}

/**
 * One or more items in a `ctx.gather` / `ctx.all` fan-out failed. Carries the per-item
 * {@link GatherFailure}s and presents an aggregate `.error` so `processTask` records the gather as a
 * failed decision. Subclasses {@link StepFailed} so it is catchable in workflow code exactly like any
 * awaited failure. Mirrors the Python `GatherFailed` and the engine's `GatherError`.
 */
export class GatherError extends StepFailed {
  readonly failures: GatherFailure[];

  constructor(failures: GatherFailure[]) {
    const labels = failures.map((f) => f.name ?? f.workflow ?? `#${f.index}`).join(', ');
    super({ message: `gather: ${failures.length} item(s) failed: ${labels}` });
    this.name = 'GatherError';
    this.failures = failures;
  }
}

/**
 * Internal: stop the replay at the first unresolved blocking op. Ends a turn. Mirrors the Python
 * `_Suspend`. Never surfaces to workflow code — `WorkflowWorker.processTask` translates it to a
 * `continue` decision.
 */
export class Suspend extends Error {
  constructor() {
    super('workflow suspended');
    this.name = 'Suspend';
  }
}

/**
 * Raised at an op boundary when the run was cancelled mid-turn (the control channel broadcast a
 * cancel for this run id). `processTask` maps it to a `cancelled` decision. Mirrors the Python
 * `Cancelled`.
 */
export class Cancelled extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`run ${runId} was cancelled`);
    this.name = 'Cancelled';
    this.runId = runId;
  }
}

/**
 * A `WorkflowCtx` op was invoked on the thin worker that the remote wire protocol can't express
 * (it needs engine/store/transport features — transactions, entities, events, async tasks,
 * absolute timers, fire-and-forget children, breakpoints, webhooks, updates, patch markers). The
 * thin worker conforms to the full {@link WorkflowCtx} surface for portability, but these members
 * fail loudly instead of silently mis-behaving — run such a workflow in-process on the engine, or
 * rewrite it against a wire-expressible op. Mirrors the engine's "needs a real store" guards.
 */
export class UnsupportedOnThinWorker extends WorkflowError {
  readonly op: string;

  constructor(op: string) {
    super(
      `ctx.${op}() is not supported on the thin worker — run this workflow in-process on the engine, or use a wire-expressible op.`,
    );
    this.name = 'UnsupportedOnThinWorker';
    this.op = op;
  }
}

/** Convert an arbitrary thrown value into the wire `StepError` shape. Mirrors Python `_to_error`. */
export function toError(err: unknown): StepError {
  if (err instanceof Error) {
    const out: StepError = { message: err.message || err.name };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) out.code = code;
    if (err.stack) out.stack = err.stack;
    return out;
  }
  return { message: String(err) || 'error' };
}
