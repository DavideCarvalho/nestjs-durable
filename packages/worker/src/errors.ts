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
