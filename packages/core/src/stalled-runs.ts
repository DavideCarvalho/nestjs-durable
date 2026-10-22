import type { StateStore, WorkflowRun } from './interfaces';

/** Default idle threshold for a stranded run: 15 minutes. */
export const DEFAULT_STALLED_AFTER_MS = 15 * 60_000;

/** The oldest unresolved remote step of a run — the lost-dispatch signature when it is old. */
export interface StalePendingStep {
  seq: number;
  name: string;
  /** How many times this step has been (re-)dispatched. A lost dispatch typically sits at 1. */
  attempts: number;
  /** Milliseconds since the step was enqueued to the transport. */
  ageMs: number;
  /**
   * The step's lease (`wakeAt`, epoch ms) when it has one: a step with a `timeoutMs`, a heartbeat
   * renewing it, or `remoteRedispatchMs`. `null` when nothing is leasing the step.
   */
  leaseUntil: number | null;
}

/** What an `engine.onStalled` listener (and {@link findStalledRuns}) receives: a stranded run and why. */
export interface StalledRunInfo {
  run: WorkflowRun;
  /** Milliseconds since the run's last activity (`updatedAt`). */
  ageMs: number;
  /** Suspended with NO wake timer — nothing will re-drive it (the `reconcileMs: 0` hazard). */
  wakeForever: boolean;
  /** The oldest pending remote step with no live lease, when that is the stranding signature. */
  stalePending: StalePendingStep | null;
}

/** Options for {@link findStalledRuns}. */
export interface FindStalledRunsOptions {
  /** Idle threshold in ms. Default {@link DEFAULT_STALLED_AFTER_MS}. */
  thresholdMs?: number | undefined;
  /** Max candidate runs inspected (newest first). Default 1000. */
  scan?: number | undefined;
  /** Evaluate as of this time (epoch ms). Default `Date.now()`. */
  now?: number | undefined;
  /** Only runs in this namespace. Omit for every namespace. */
  namespace?: string | undefined;
}

/**
 * The stranded runs in a store right now — the query behind `engine.sweepStalled`/`onStalled`,
 * `engine.listStalledRuns` and the CLI's `durable inspect --stale`. Works on a bare store, so an
 * ops script or a CLI can run it without an engine.
 *
 * A `running`/`suspended` run qualifies when it has been untouched for `thresholdMs` AND either:
 *
 * - it is suspended with NO wake timer (`wakeForever`): nothing will ever re-drive it; or
 * - its oldest pending REMOTE step is older than the threshold and has no lease in the future
 *   (`stalePending`): the dispatch was most likely lost.
 *
 * Healthy long work is excluded: a long `ctx.sleep` has a future `wakeAt` and no pending step, and a
 * remote step with a `timeoutMs`, a heartbeat or `remoteRedispatchMs` carries a future lease. Issues
 * one `listCheckpoints` per idle candidate, bounded by `scan`: an operator read, not a hot path.
 */
export async function findStalledRuns(
  store: Pick<StateStore, 'listRuns' | 'listCheckpoints'>,
  options: FindStalledRunsOptions = {},
): Promise<StalledRunInfo[]> {
  const now = options.now ?? Date.now();
  const thresholdMs = options.thresholdMs ?? DEFAULT_STALLED_AFTER_MS;
  const scan = Math.max(1, options.scan ?? 1_000);
  const pageSize = Math.min(200, scan);
  const stalled: StalledRunInfo[] = [];
  for (let offset = 0; offset < scan; offset += pageSize) {
    const limit = Math.min(pageSize, scan - offset);
    const page = await store.listRuns({
      statuses: ['running', 'suspended'],
      ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
      limit,
      offset,
    });
    for (const run of page) {
      const ageMs = now - run.updatedAt.getTime();
      if (ageMs < thresholdMs) continue;
      const info = await stalledInfo(store, run, now, thresholdMs, ageMs);
      if (info) stalled.push(info);
    }
    if (page.length < limit) break;
  }
  return stalled;
}

async function stalledInfo(
  store: Pick<StateStore, 'listCheckpoints'>,
  run: WorkflowRun,
  now: number,
  thresholdMs: number,
  ageMs: number,
): Promise<StalledRunInfo | null> {
  let stalePending: StalePendingStep | null = null;
  for (const cp of await store.listCheckpoints(run.id)) {
    if (cp.kind !== 'remote' || cp.status !== 'pending') continue;
    const stepAgeMs = now - cp.enqueuedAt.getTime();
    if (stepAgeMs < thresholdMs) continue;
    // A lease still in the future: a timeout, a heartbeat or the redispatch net is watching it.
    if (cp.wakeAt != null && cp.wakeAt > now) continue;
    if (!stalePending || stepAgeMs > stalePending.ageMs) {
      stalePending = {
        seq: cp.seq,
        name: cp.name,
        attempts: cp.attempts,
        ageMs: stepAgeMs,
        leaseUntil: cp.wakeAt ?? null,
      };
    }
  }
  const wakeForever = run.status === 'suspended' && run.wakeAt == null;
  if (!wakeForever && !stalePending) return null;
  return { run, ageMs, wakeForever, stalePending };
}
