import type { WorkflowEngine } from './engine';

export interface ScheduledWorkflow {
  /** Stable key identifying this schedule — part of the deterministic run id. */
  key: string;
  workflow: string;
  input?: unknown;
  /** Start one run every `everyMs`. */
  everyMs: number;
}

/** Deterministic run id for a schedule's current time window — stable within that window. */
export function scheduledRunId(key: string, everyMs: number, nowMs: number): string {
  return `sched:${key}:${Math.floor(nowMs / everyMs)}`;
}

/**
 * Start each schedule's current-window run. The run id is the time bucket and `engine.start` is
 * idempotent, so firing this on an interval — or racing two instances on the same tick — starts
 * **each window exactly once**. Wire it to a `setInterval`, the durable timer poller, or
 * `@nestjs/schedule`. Returns the run ids for the current windows.
 */
export async function runSchedules(
  engine: Pick<WorkflowEngine, 'start'>,
  schedules: readonly ScheduledWorkflow[],
  nowMs: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (const s of schedules) {
    const runId = scheduledRunId(s.key, s.everyMs, nowMs);
    await engine.start(s.workflow, s.input, runId);
    ids.push(runId);
  }
  return ids;
}
