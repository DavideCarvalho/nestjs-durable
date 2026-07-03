import type { GroupHealth } from './durable-client';

/** Health-first summary of the whole `/durable` worker fleet, across every queue. */
export interface HealthSummary {
  /** Total number of groups (queues), healthy or not. */
  queueCount: number;
  /** Distinct `instanceId`s across every group's `liveWorkers` — a worker on many queues counts once. */
  workerCount: number;
  /** Groups with backlog and no worker consuming it, sorted by `depth` descending. */
  starved: GroupHealth[];
  /** True when `starved` is empty — the whole fleet is draining. */
  allDraining: boolean;
}

/**
 * Reduce the (potentially ~40-queue) `GroupHealth` list to the one actionable signal: which
 * queues have backlog with nobody consuming it. `Array.prototype.sort` is stable (ES2019+), so
 * groups tied on `depth` keep their input order.
 */
export function summarizeHealth(groups: GroupHealth[]): HealthSummary {
  const instanceIds = new Set<string>();
  for (const group of groups) {
    for (const worker of group.liveWorkers) instanceIds.add(worker.instanceId);
  }

  const starved = groups
    .filter((group) => group.depth > 0 && group.liveWorkers.length === 0)
    .sort((a, b) => b.depth - a.depth);

  return {
    queueCount: groups.length,
    workerCount: instanceIds.size,
    starved,
    allDraining: starved.length === 0,
  };
}
