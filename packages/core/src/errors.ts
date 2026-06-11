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
