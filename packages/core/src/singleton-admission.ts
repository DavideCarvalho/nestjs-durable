import { type RunStatus, TERMINAL_RUN_STATUSES, type WorkflowRun } from './interfaces';

/** Reserved engine metadata: a durable singleton slot, independent of the execution lease. */
export const SINGLETON_ADMITTED_TAG = 'durable:singleton:admitted';
/**
 * Reserved engine metadata: this not-yet-admitted run's admission is decided by the tag scheme, so
 * it holds no slot unless it carries {@link SINGLETON_ADMITTED_TAG}. Stamped on a run's first
 * execution (`pending` -> `running`) and on every denial. An untagged run WITHOUT it that a
 * replica has executed was executed by a replica older than 0.73: see
 * {@link legacySingletonHolders}. Admission and terminal settlement remove it.
 */
export const SINGLETON_TRACKED_TAG = 'durable:singleton:tracked';
/** Tags only the engine/store may write; stripped from user-supplied start tags. */
export const SINGLETON_RESERVED_TAGS: readonly string[] = [
  SINGLETON_ADMITTED_TAG,
  SINGLETON_TRACKED_TAG,
];
export const SINGLETON_ACTIVE_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'blocked',
  'cancelling',
];

/**
 * The statuses a pre-0.73 replica's scan-based admission counted (see {@link legacySingletonHolders}).
 * Deliberately NOT {@link SINGLETON_ACTIVE_STATUSES}: the old scan ignored `pending` and `blocked`.
 */
const LEGACY_SCAN_STATUSES: RunStatus[] = ['running', 'suspended', 'cancelling'];

const byAdmissionOrder = (a: WorkflowRun, b: WorkflowRun) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** `tags` without the engine's singleton admission metadata. */
export function withoutSingletonMarkers(tags: string[] | undefined): string[] | undefined {
  return tags?.filter((tag) => !SINGLETON_RESERVED_TAGS.includes(tag));
}

/** `tags` carrying {@link SINGLETON_TRACKED_TAG} (unchanged when admitted or already tracked). */
export function withSingletonTracked(tags: string[] | undefined): string[] {
  const current = tags ?? [];
  if (current.includes(SINGLETON_ADMITTED_TAG) || current.includes(SINGLETON_TRACKED_TAG)) {
    return current;
  }
  return [...current, SINGLETON_TRACKED_TAG];
}

/**
 * The runs other than `runId` that may hold a slot of this key WITHOUT carrying
 * {@link SINGLETON_ADMITTED_TAG}: holders admitted by a replica older than 0.73, during a rolling
 * upgrade that mixes old and new replicas.
 *
 * Old replicas admit by a scan: a run may execute when it is among the `limit` oldest
 * `running`/`suspended`/`cancelling` runs sharing the key, by `(createdAt, id)`, and they write no
 * tag. Among those statuses, an untagged run counts as a legacy holder when either:
 *
 * - it lacks {@link SINGLETON_TRACKED_TAG}. A new replica stamps that marker on a run's first
 *   execution and on every denial, so an untagged executed run without it was executed (admitted)
 *   by an old replica. A denial alone cannot be told apart from a holder (both old and new denials
 *   park the run `suspended` with a retry `wakeAt`, exactly like a holder sleeping in `ctx.sleep`),
 *   which is why the marker exists. Waiters an old replica parked count too until a new replica
 *   re-checks them (one retry, ~1s), which only delays, never over-admits.
 * - it sits inside the old scan's own window (the `limit` oldest of those runs). An old replica can
 *   admit a run a new replica had marked, without clearing the marker; the window is what it
 *   admitted it on. Without old replicas this never changes a `limit: 1` decision (a run inside the
 *   window is the head of the FIFO, admitted next anyway); with a larger limit it can only delay one.
 */
export function legacySingletonHolders(
  active: WorkflowRun[],
  runId: string,
  limit: number,
): WorkflowRun[] {
  const scanned = active
    .filter((run) => LEGACY_SCAN_STATUSES.includes(run.status))
    .sort(byAdmissionOrder);
  const window = new Set(scanned.slice(0, limit).map((run) => run.id));
  return scanned.filter(
    (run) =>
      run.id !== runId &&
      !run.tags?.includes(SINGLETON_ADMITTED_TAG) &&
      (!run.tags?.includes(SINGLETON_TRACKED_TAG) || window.has(run.id)),
  );
}

/** Call only inside a store's atomic admission transaction/critical section. */
export function singletonAdmissionTags(
  runs: WorkflowRun[],
  runId: string,
  tag: string,
  workflow: string,
  limit: number,
): string[] | null {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('singleton limit must be a positive integer');
  const active = runs.filter(
    (run) =>
      run.workflow === workflow &&
      SINGLETON_ACTIVE_STATUSES.includes(run.status) &&
      run.tags?.includes(tag),
  );
  const candidate = active.find((run) => run.id === runId);
  if (!candidate) return null;
  if (candidate.tags?.includes(SINGLETON_ADMITTED_TAG)) return candidate.tags;
  if (candidate.status === 'cancelling') return null;
  const holders = active.filter((run) => run.tags?.includes(SINGLETON_ADMITTED_TAG));
  // Holders admitted by a pre-0.73 replica (mixed fleet during a rolling upgrade) carry no tag.
  const legacy = new Set(legacySingletonHolders(active, runId, limit).map((run) => run.id));
  const remaining = limit - holders.length - legacy.size;
  if (remaining <= 0) return null;
  const waiters = active
    .filter((run) => !run.tags?.includes(SINGLETON_ADMITTED_TAG) && !legacy.has(run.id))
    .sort(byAdmissionOrder);
  if (!waiters.slice(0, remaining).some((run) => run.id === runId)) return null;
  return [
    ...(candidate.tags ?? []).filter((t) => t !== SINGLETON_TRACKED_TAG),
    SINGLETON_ADMITTED_TAG,
  ];
}

/** Terminal runs release admission, including when later resumed directly rather than requeued. */
export async function clearTerminalSingletonAdmission(
  runId: string,
  patch: Partial<WorkflowRun>,
  getRun: (id: string) => Promise<WorkflowRun | null>,
): Promise<Partial<WorkflowRun>> {
  if (!patch.status || !TERMINAL_RUN_STATUSES.includes(patch.status)) return patch;
  const tags = 'tags' in patch ? patch.tags : (await getRun(runId))?.tags;
  return { ...patch, tags: withoutSingletonMarkers(tags) };
}

/** Persist denial while admission locks are held; a cancelling/terminal run must never revive. */
export function singletonAdmissionDenialPatch(
  runs: WorkflowRun[],
  runId: string,
  tag: string,
  workflow: string,
  retryWakeAt?: number,
): { status: 'suspended'; wakeAt: number; tags: string[]; updatedAt: Date } | undefined {
  if (retryWakeAt === undefined) return undefined;
  const candidate = runs.find(
    (run) =>
      run.id === runId &&
      run.workflow === workflow &&
      run.tags?.includes(tag) &&
      SINGLETON_ACTIVE_STATUSES.includes(run.status),
  );
  if (!candidate || candidate.status === 'cancelling') return undefined;
  // Marked as a waiter the tag scheme tracks, so it is never mistaken for a legacy holder.
  return {
    status: 'suspended',
    wakeAt: retryWakeAt,
    tags: withSingletonTracked(candidate.tags),
    updatedAt: new Date(),
  };
}
