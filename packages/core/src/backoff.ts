import { FatalError } from './errors';
import type { StepOptions } from './interfaces';

/** Delay in ms before the next retry attempt, per a step's `StepOptions` backoff config. Shared by
 *  the local-step retry loop and the durable remote-step retry, so they stay consistent. */
export function backoffDelay(attempt: number, options?: StepOptions): number {
  const base = options?.backoffMs ?? 0;
  if (base <= 0) return 0;
  const raw = options?.backoff === 'exp' ? base * 2 ** (attempt - 1) : base;
  const capped = options?.backoffMaxMs ? Math.min(raw, options.backoffMaxMs) : raw;
  return options?.jitter ? Math.round(capped * (0.5 + Math.random() * 0.5)) : capped;
}

/** How a {@link retryLocalStep} loop ended: the value of the attempt that succeeded, or the error of
 *  the last one, with the number of attempts made either way. */
export type LocalStepOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number };

/**
 * The local-step retry loop both runtimes run, so `ctx.localStep` behaves the same in-process and on
 * the thin worker. Calls `attempt(n)` for `n = 1, 2, …` until one resolves, `options.retries` attempts
 * have failed (`retries` is the TOTAL attempt count, floored at 1), or one throws a
 * {@link FatalError}, which is never retried. Between attempts it waits {@link backoffDelay} in
 * process: the wait is not a durable timer, so a process that dies mid-backoff re-runs the step from
 * attempt 1 when the turn is replayed. Never throws; the caller records and raises the outcome.
 */
export async function retryLocalStep<T>(
  options: StepOptions | undefined,
  attempt: (n: number) => Promise<T>,
): Promise<LocalStepOutcome<T>> {
  const maxAttempts = Math.max(1, options?.retries ?? 1);
  for (let n = 1; ; n += 1) {
    try {
      return { ok: true, value: await attempt(n), attempts: n };
    } catch (error) {
      if (error instanceof FatalError || n >= maxAttempts) return { ok: false, error, attempts: n };
      const wait = backoffDelay(n, options);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
