import { useQuery } from '@tanstack/react-query';
import {
  SINGLETON_INFLIGHT_STATUSES,
  type WorkflowRun,
  durableClient,
} from '../../client/durable-client';

/** Whether any of these runs is parked as a singleton — the only case whose display state needs the
 *  sibling set at all. On a deployment that uses no singletons this is always false, so the query
 *  below never runs. */
export function anySingleton(runs: readonly WorkflowRun[]): boolean {
  return runs.some(
    (r) => r.status === 'suspended' && r.tags?.some((t) => t.startsWith('singleton:')),
  );
}

/**
 * The IN-FLIGHT runs a singleton row is placed among — `deriveRunState` picks the oldest of them as
 * the leader, exactly as the engine's `admit()` does.
 *
 * Fetched as its own bounded query rather than reusing whatever list is on screen, because both
 * callers now hold a PAGE and the leader is by definition the oldest sibling — the row most likely to
 * have fallen off it. In-flight is the working set, not the history, so this stays small no matter how
 * many runs a control plane has accumulated. One `queryKey` for both callers, so the list and an open
 * run share a single fetch.
 */
export function useSingletonSiblings(needed: boolean): WorkflowRun[] {
  const { data = [] } = useQuery({
    queryKey: ['runs', 'in-flight'],
    queryFn: () =>
      durableClient.runs(undefined, undefined, undefined, {
        statuses: SINGLETON_INFLIGHT_STATUSES,
        limit: 500,
      }),
    enabled: needed,
    refetchInterval: 5000,
  });
  return data;
}
