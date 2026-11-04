import type { RunStatus, WorkflowRun } from './interfaces';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_TRIGGERED_TAG_PREFIX,
  lifecycleKindOf,
  lifecycleRunId,
  owedSubscribersOf,
  triggerFailedSubscribersOf,
} from './lifecycle-events';

/**
 * One end of a `ctx.waitForRun` wait, as a run detail lists it: the run waited for (`waitsFor`) or
 * the waiting run (`awaitedBy`), the waiting run's `seq` of the call, and the other run's status and
 * namespace when it was read.
 */
export interface RunWaitLink {
  runId: string;
  seq: number;
  status?: RunStatus | undefined;
  namespace?: string | undefined;
}

/**
 * Where a settled run's lifecycle event stands for one subscriber:
 * - `started`: its run exists (`runId`, a `durable:triggered:<subscriber>` tag);
 * - `owed`: still pending (a `durable:lifecycle:owed:<subscriber>` tag);
 * - `coalesced`: routed into a debounce/batch accumulator (`runId` is the accumulator's, when it
 *   can be derived);
 * - `failed`: its start failed (a `durable:trigger_failed:<subscriber>` tag): its `where` threw, its
 *   input was rejected, its start threw, or the sweep dropped it as orphaned. A republish retries it;
 * - `not-started`: no run and nothing owed: its `where` declined the event, it coalesces on another
 *   instance, or it subscribed after the run settled.
 */
export type LifecycleDeliveryState = 'started' | 'owed' | 'coalesced' | 'failed' | 'not-started';

/** One subscriber of a settled run's lifecycle event, as the run detail lists it. */
export interface LifecycleDelivery {
  subscriber: string;
  state: LifecycleDeliveryState;
  /** The subscriber's run when `started`; the accumulator run when `coalesced` and derivable. */
  runId?: string | undefined;
  /** The status of a `started` subscriber's run, when it was read. */
  status?: RunStatus | undefined;
  /** The namespace of a `started` subscriber's run, when it was read. */
  namespace?: string | undefined;
  /** When an `owed` subscriber became owed: the settled run's last update (epoch ms). */
  owedSince?: number | undefined;
  /**
   * When the lifecycle sweep drops an `owed` subscriber that no live instance registers or
   * announces for the run's namespace (epoch ms; see {@link LIFECYCLE_ORPHAN_MS}). Absent while one
   * does.
   */
  orphanAt?: number | undefined;
  /**
   * Why a `failed` subscriber did not start, when the caller knows it (the run's tags record only
   * that it failed; the `run.trigger_failed` event carries the message). {@link lifecycleDeliveriesOf}
   * leaves it unset.
   */
  error?: string | undefined;
}

/**
 * The {@link LifecycleDelivery} of each subscriber of a settled run, sorted by subscriber: the
 * union of `subscribers` (the ones the run's event goes to now) and the owed, triggered and
 * trigger-failed tags. `live` names the subscribers a live instance registers or announces; an owed subscriber
 * outside it gets `orphanAt`. `coalesced` maps each subscriber that coalesces its events to its
 * accumulator run id (undefined when it cannot be derived). Empty for a run that has not settled.
 */
export function lifecycleDeliveriesOf(
  run: Pick<WorkflowRun, 'id' | 'status' | 'tags' | 'updatedAt'>,
  opts: {
    subscribers: readonly string[];
    live: ReadonlySet<string>;
    coalesced?: ReadonlyMap<string, string | undefined> | undefined;
  },
): LifecycleDelivery[] {
  const kind = lifecycleKindOf(run.status);
  if (!kind) return [];
  const tags = run.tags ?? [];
  const owed = new Set(owedSubscribersOf(tags));
  const triggered = new Set(
    tags
      .filter((t) => t.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX))
      .map((t) => t.slice(LIFECYCLE_TRIGGERED_TAG_PREFIX.length)),
  );
  const triggerFailed = new Set(triggerFailedSubscribersOf(tags));
  // A run marked pending without owed tags is owed to every subscriber it has not started.
  const owedToAll = owed.size === 0 && tags.includes(LIFECYCLE_PENDING_TAG);
  const settledAt = new Date(run.updatedAt).getTime();
  const names = [...new Set([...opts.subscribers, ...owed, ...triggered, ...triggerFailed])].sort();
  return names.map((subscriber): LifecycleDelivery => {
    if (triggered.has(subscriber)) {
      return { subscriber, state: 'started', runId: lifecycleRunId(run.id, kind, subscriber) };
    }
    if (triggerFailed.has(subscriber)) return { subscriber, state: 'failed' };
    if (owed.has(subscriber) || owedToAll) {
      return {
        subscriber,
        state: 'owed',
        owedSince: settledAt,
        ...(opts.live.has(subscriber) ? {} : { orphanAt: settledAt + LIFECYCLE_ORPHAN_MS }),
      };
    }
    if (opts.coalesced?.has(subscriber)) {
      const runId = opts.coalesced.get(subscriber);
      return { subscriber, state: 'coalesced', ...(runId !== undefined ? { runId } : {}) };
    }
    return { subscriber, state: 'not-started' };
  });
}

/** The trace id of a W3C `traceparent` (`00-<trace id>-<span id>-<flags>`), or undefined. */
export function traceIdOfTraceparent(traceparent: string | undefined): string | undefined {
  const traceId = traceparent?.split('-')[1];
  return traceId && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId) ? traceId : undefined;
}
