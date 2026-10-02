import { type RunStatus, TERMINAL_RUN_STATUSES, type WorkflowRun } from './interfaces';

/** Reserved engine metadata: a durable singleton slot, independent of the execution lease. */
export const SINGLETON_ADMITTED_TAG = 'durable:singleton:admitted';
export const SINGLETON_ACTIVE_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'blocked',
  'cancelling',
];

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
  const remaining = limit - holders.length;
  if (remaining <= 0) return null;
  const waiters = active
    .filter((run) => !run.tags?.includes(SINGLETON_ADMITTED_TAG))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  if (!waiters.slice(0, remaining).some((run) => run.id === runId)) return null;
  return [...(candidate.tags ?? []), SINGLETON_ADMITTED_TAG];
}

/** Terminal runs release admission, including when later resumed directly rather than requeued. */
export async function clearTerminalSingletonAdmission(
  runId: string,
  patch: Partial<WorkflowRun>,
  getRun: (id: string) => Promise<WorkflowRun | null>,
): Promise<Partial<WorkflowRun>> {
  if (!patch.status || !TERMINAL_RUN_STATUSES.includes(patch.status)) return patch;
  const tags = 'tags' in patch ? patch.tags : (await getRun(runId))?.tags;
  return { ...patch, tags: tags?.filter((tag) => tag !== SINGLETON_ADMITTED_TAG) };
}

/** Persist denial while admission locks are held; a cancelling/terminal run must never revive. */
export function singletonAdmissionDenialPatch(
  runs: WorkflowRun[],
  runId: string,
  tag: string,
  workflow: string,
  retryWakeAt?: number,
): { status: 'suspended'; wakeAt: number; updatedAt: Date } | undefined {
  if (retryWakeAt === undefined) return undefined;
  const candidate = runs.find(
    (run) =>
      run.id === runId &&
      run.workflow === workflow &&
      run.tags?.includes(tag) &&
      SINGLETON_ACTIVE_STATUSES.includes(run.status),
  );
  if (!candidate || candidate.status === 'cancelling') return undefined;
  return { status: 'suspended', wakeAt: retryWakeAt, updatedAt: new Date() };
}
