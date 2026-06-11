/**
 * Thrown inside a step to signal an unrecoverable failure: the engine will NOT retry it,
 * regardless of the step's `retries` setting, and fails the run immediately. Use it for
 * business errors that retrying cannot fix (e.g. a declined card, invalid input).
 */
export class FatalError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'FatalError';
    this.code = code;
  }
}

/**
 * Internal control signal thrown to suspend a run (e.g. on a durable sleep). Not an error the
 * user should throw or catch; the engine uses it to stop execution and persist `wakeAt`.
 */
export class WorkflowSuspended extends Error {
  readonly wakeAt: number;
  constructor(wakeAt: number) {
    super('workflow suspended');
    this.name = 'WorkflowSuspended';
    this.wakeAt = wakeAt;
  }
}
