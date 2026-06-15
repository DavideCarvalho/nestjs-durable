import type { StepEvent } from './durable-client';

/** A sub-process reconstructed from a step's events, keyed by run identity. */
export interface SubProcess {
  id: string;
  name: string;
  group?: string;
  /** Intermediate transitions (events carrying a `phase`), in arrival order. */
  phases: StepEvent[];
  /** Log lines owned by this sub-process (no `phase`, no `status`), in arrival order. */
  logs: StepEvent[];
  /** The terminal event (carries a `status`), if the sub has finished. */
  terminal?: StepEvent;
  status?: 'ok' | 'failed' | 'skipped';
  /** Earliest `at` across this sub's events. */
  startedAt?: number;
  /** `data.durationMs` when provided, else `terminal.at − startedAt`. */
  durationMs?: number;
}

function durationFromData(data: unknown): number | undefined {
  if (typeof data === 'object' && data !== null && 'durationMs' in data) {
    const value = (data as Record<string, unknown>).durationMs;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Group a step's events into sub-processes by run identity (`subId`, falling back to `name` then the
 * legacy `process` tag). Events with no owner (step-level logs) are returned separately. `Map`
 * iteration preserves first-seen order, so subs come back in the order they first appeared.
 */
export function groupSubProcesses(events: StepEvent[]): {
  subs: SubProcess[];
  stepLogs: StepEvent[];
} {
  const byId = new Map<string, SubProcess>();
  const stepLogs: StepEvent[] = [];

  for (const event of events) {
    // key === undefined iff the event carries none of subId/name/process — a step-level log.
    const key = event.subId ?? event.name ?? event.process;
    if (key === undefined) {
      stepLogs.push(event);
      continue;
    }
    const existing = byId.get(key);
    const sub: SubProcess = existing ?? { id: key, name: event.name ?? key, phases: [], logs: [] };
    if (!existing) byId.set(key, sub);
    if (event.name !== undefined) sub.name = event.name;
    if (event.group !== undefined) sub.group = event.group;
    if (event.status !== undefined) {
      sub.terminal = event;
      sub.status = event.status;
    } else if (event.phase !== undefined) {
      sub.phases.push(event);
    } else {
      sub.logs.push(event);
    }
  }

  const subs = [...byId.values()].map((sub) => {
    const stamps = [...sub.phases, ...sub.logs, ...(sub.terminal ? [sub.terminal] : [])].map(
      (e) => e.at,
    );
    const startedAt = stamps.length ? Math.min(...stamps) : undefined;
    const fromData = durationFromData(sub.terminal?.data);
    const durationMs =
      fromData ??
      (sub.terminal && startedAt !== undefined ? sub.terminal.at - startedAt : undefined);
    return { ...sub, startedAt, durationMs };
  });

  return { subs, stepLogs };
}
