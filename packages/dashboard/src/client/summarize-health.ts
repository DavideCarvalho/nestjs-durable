import type { GroupHealth } from './durable-client.js';
import { baseHandlerName } from './queue-partition.js';

/** Health-first summary of the whole `/durable` worker fleet, across every queue. */
export interface HealthSummary {
  /** Total number of groups (queues), healthy or not. */
  queueCount: number;
  /** Distinct `@Workflow` bodies served, deduped by base name across partitions. Route-by-handler runs
   *  each as its own queue, so this is the domain count behind the raw `queueCount`. */
  workflowCount: number;
  /** Distinct `@Step`/handler names served, deduped by base name across partitions. */
  stepCount: number;
  /** Distinct `instanceId`s across every group's `liveWorkers` — a worker on many queues counts once. */
  workerCount: number;
  /** Groups with backlog and no worker consuming it, sorted by `depth` descending. */
  starved: GroupHealth[];
  /** True when `starved` is empty — the whole fleet is draining. */
  allDraining: boolean;
}

/**
 * The WORKFLOW queues that are stalled — backlog with no worker anywhere consuming it — by base name,
 * ignoring the `@partition` suffix queues carry on a tenant (they aggregate across tenants, same rule
 * as `deriveRunState`'s `groupIsStalled`).
 *
 * Read off worker health rather than off the run list, which matters now the console lists a PAGE: a
 * banner derived from the runs on screen would go quiet the moment the stalled runs scrolled past the
 * page boundary, which is exactly when an operator most needs to see it. A stalled queue has queued
 * work by definition, so nothing is lost by not consulting the runs.
 */
export function stalledWorkflows(groups: readonly GroupHealth[]): string[] {
  const backlog = new Set<string>();
  const served = new Set<string>();
  for (const group of groups) {
    if (group.kind !== 'workflow') continue;
    const base = baseHandlerName(group.group);
    if (group.depth > 0) backlog.add(base);
    if (group.liveWorkers.length > 0) served.add(base);
  }
  return [...backlog].filter((name) => !served.has(name)).sort();
}

/**
 * Reduce the (potentially ~40-queue) `GroupHealth` list to the one actionable signal: which
 * queues have backlog with nobody consuming it. `Array.prototype.sort` is stable (ES2019+), so
 * groups tied on `depth` keep their input order.
 */
export function summarizeHealth(groups: GroupHealth[]): HealthSummary {
  const instanceIds = new Set<string>();
  // Dedupe by base handler name so `pipeline@davi-local` and `pipeline@default` count as ONE workflow
  // (the domain count), not two queues. A group with no live worker still counts — it's a known/served
  // handler, just idle. Unclassified groups (`kind` undefined) fall into neither bucket.
  const workflowNames = new Set<string>();
  const stepNames = new Set<string>();
  for (const group of groups) {
    for (const worker of group.liveWorkers) instanceIds.add(worker.instanceId);
    if (group.kind === 'workflow') workflowNames.add(baseHandlerName(group.group));
    else if (group.kind === 'step') stepNames.add(baseHandlerName(group.group));
  }

  const starved = groups
    .filter((group) => group.depth > 0 && group.liveWorkers.length === 0)
    .sort((a, b) => b.depth - a.depth);

  return {
    queueCount: groups.length,
    workflowCount: workflowNames.size,
    stepCount: stepNames.size,
    workerCount: instanceIds.size,
    starved,
    allDraining: starved.length === 0,
  };
}
