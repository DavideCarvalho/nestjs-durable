import type { SignalWaiter, StateStore, WorkflowRun } from './interfaces';
import { lifecycleKindOf } from './lifecycle-events';

/**
 * `ctx.waitForRun(runId)`: a durable wait for any run to settle, built on the signal-waiter table.
 * The waiter's token embeds the target run and the waiting call's own `runId#seq`, so no two calls
 * share one, and the engine finds a run's waiters by the {@link runWaitPrefix} of its id.
 */

/** The literal every run-wait token starts with. */
export const RUN_WAIT_TOKEN_PREFIX = 'runwait:';

/** Token prefix shared by every waiter on `targetRunId`. */
export function runWaitPrefix(targetRunId: string): string {
  return `${RUN_WAIT_TOKEN_PREFIX}${targetRunId}#`;
}

/** The waiter token for one `ctx.waitForRun(targetRunId)` call at `seq` of run `runId`. */
export function runWaitToken(targetRunId: string, runId: string, seq: number): string {
  return `${runWaitPrefix(targetRunId)}${runId}#${seq}`;
}

/**
 * The run a `ctx.waitForRun` waiter waits on, or undefined when `waiter` is not one. Read against
 * the waiter's own `runId` and `seq`, so a target id containing `#` is still read exactly, and a
 * prefix listing for run `a` that also returns the waiters of run `a#b` can be told apart.
 */
export function runWaitTargetOf(
  waiter: Pick<SignalWaiter, 'token' | 'runId' | 'seq'>,
): string | undefined {
  const suffix = `#${waiter.runId}#${waiter.seq}`;
  const { token } = waiter;
  if (!token.startsWith(RUN_WAIT_TOKEN_PREFIX) || !token.endsWith(suffix)) return undefined;
  const target = token.slice(RUN_WAIT_TOKEN_PREFIX.length, token.length - suffix.length);
  return target.length > 0 ? target : undefined;
}

/** The id for the next continuation of a run: `r` → `r~1` → `r~2` … (stable, traceable lineage). */
export function nextContinuationId(runId: string): string {
  const m = runId.match(/^(.*)~(\d+)$/);
  return m ? `${m[1]}~${Number(m[2]) + 1}` : `${runId}~1`;
}

/** How many continue-as-new hops {@link settledRunOf} follows before treating the chain as running. */
const MAX_CONTINUATION_HOPS = 100;

/**
 * Where `runId` stands for a run waiter: `missing` when no such run exists, `running` while it (or
 * the continuation it handed off to with `continueAsNew`) has not settled, else the settled run
 * that ends its continue-as-new chain.
 */
export async function settledRunOf(
  store: Pick<StateStore, 'getRun'>,
  runId: string,
): Promise<{ state: 'missing' } | { state: 'running' } | { state: 'settled'; run: WorkflowRun }> {
  let run = await store.getRun(runId);
  if (!run) return { state: 'missing' };
  for (let hop = 0; hop <= MAX_CONTINUATION_HOPS; hop += 1) {
    if (!lifecycleKindOf(run.status)) return { state: 'running' };
    if (run.status !== 'completed') return { state: 'settled', run };
    const next: WorkflowRun | null = await store.getRun(nextContinuationId(run.id));
    if (!next) return { state: 'settled', run };
    run = next;
  }
  return { state: 'running' };
}
