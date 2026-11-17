import type { RemoteCallPolicy, StepDispatchOpts, StepError } from './interfaces';
import type { StepConfig } from './step-name-symbol';

/**
 * The durable dispatch policy of a `ctx.step` call as a remote `call` command carries it: the
 * `@Step`-declared config, with a per-call `opts` field winning wherever it is set — the same merge
 * the in-process `ctx.step` applies. `undefined` when neither declares any policy field, so a call
 * without one stays wire-identical to a call from before policies were carried.
 */
export function remoteCallPolicyOf(
  config: StepConfig | undefined,
  opts: StepDispatchOpts | undefined,
): RemoteCallPolicy | undefined {
  const policy: RemoteCallPolicy = {};
  const retries = opts?.retries ?? config?.retries;
  if (retries !== undefined) policy.retries = retries;
  const backoff = opts?.backoff ?? config?.backoff;
  if (backoff !== undefined) policy.backoff = backoff;
  const backoffMs = opts?.backoffMs ?? config?.backoffMs;
  if (backoffMs !== undefined) policy.backoffMs = backoffMs;
  const backoffMaxMs = opts?.backoffMaxMs ?? config?.backoffMaxMs;
  if (backoffMaxMs !== undefined) policy.backoffMaxMs = backoffMaxMs;
  const jitter = opts?.jitter ?? config?.jitter;
  if (jitter !== undefined) policy.jitter = jitter;
  const timeoutMs = opts?.timeoutMs ?? config?.timeoutMs;
  if (timeoutMs !== undefined) policy.timeoutMs = timeoutMs;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/** Total dispatch attempts a policy allows (`retries`, at least one) — the in-process rule. */
export function remoteCallMaxAttempts(policy: RemoteCallPolicy | undefined): number {
  return Math.max(1, policy?.retries ?? 1);
}

/**
 * Whether a remote `call` whose attempt `attempts` FAILED with `error` is dispatched again under
 * `policy`, exactly as the in-process durable path decides it: never with a liveness `timeoutMs`
 * (there only a timeout is retried, a reported failure is final), never for an error the worker
 * marked non-retryable, and only while attempts remain. The worker's replay and the control plane
 * both decide with this one function, so they cannot disagree about a retry.
 */
export function remoteCallRetries(
  policy: RemoteCallPolicy | undefined,
  attempts: number,
  error: StepError | undefined,
): boolean {
  if (policy === undefined || policy.timeoutMs) return false;
  if (error?.retryable === false) return false;
  return attempts < remoteCallMaxAttempts(policy);
}
