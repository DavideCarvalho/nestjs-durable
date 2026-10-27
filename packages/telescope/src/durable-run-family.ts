/**
 * The Telescope `familyHash` of a run-level lifecycle entry, e.g. `durable:run.completed`.
 *
 * `family_hash` is an indexed column on every storage provider, so stamping run events with one lets
 * the Workflows panels read exactly those events. Step events carry none: a wide fan records tens of
 * thousands of them, and reading "the latest durable entries" would return nothing but steps.
 */
export function runEventFamily(eventType: string): string | undefined {
  return RUN_EVENT_TYPES.has(eventType) ? `durable:${eventType}` : undefined;
}

const RUN_EVENT_TYPES = new Set(['run.started', 'run.completed', 'run.failed', 'run.suspended']);
