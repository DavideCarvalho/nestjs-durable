import { createHash } from 'node:crypto';

/**
 * The Telescope `familyHash` of a run-level lifecycle entry, e.g. `durable:run.completed`.
 *
 * `family_hash` is an indexed column on every storage provider, so stamping run events with one lets
 * the Workflows panels read exactly those events. Step events carry none of these: a wide fan records
 * tens of thousands of them, and reading "the latest durable entries" would return nothing but steps.
 * A step's outcome has its own family instead ({@link stepEventFamily}).
 */
export function runEventFamily(eventType: string): string | undefined {
  return RUN_EVENT_TYPES.has(eventType) ? `durable:${eventType}` : undefined;
}

const RUN_EVENT_TYPES = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.suspended',
  'run.triggered',
  'run.trigger_failed',
]);

/**
 * The family of a step's outcome (`step.completed` / `step.failed`): `durable:step:<name>`, the same
 * for both, so Telescope's "Slowest jobs" ranks each step by name from the indexed family and
 * duration columns alone (its p95, max, executions, and the failures from the `failed` tag).
 * `undefined` for any other event, an unnamed step, or a sleep / signal wait (not work).
 *
 * Kept within {@link MAX_FAMILY_LENGTH}: a longer name is cut and suffixed with a short hash of the
 * whole name, so two long names that share a beginning stay two families.
 */
export function stepEventFamily(
  eventType: string,
  name: string | undefined,
  kind?: string | undefined,
): string | undefined {
  if (eventType !== 'step.completed' && eventType !== 'step.failed') return undefined;
  if (name === undefined || name === '' || kind === 'sleep' || kind === 'signal') return undefined;
  const family = `${STEP_FAMILY_PREFIX}${name}`;
  if (family.length <= MAX_FAMILY_LENGTH) return family;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${family.slice(0, MAX_FAMILY_LENGTH - hash.length - 1)}~${hash}`;
}

/** The family prefix of a step's outcome (see {@link stepEventFamily}). */
export const STEP_FAMILY_PREFIX = 'durable:step:';

/** The narrowest `family_hash` column of a Telescope store (the MikroORM entity's `VARCHAR(64)`). */
export const MAX_FAMILY_LENGTH = 64;
