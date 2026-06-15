import type { WorkflowEngine } from './engine';

export interface ScheduledWorkflow {
  /** Stable key identifying this schedule — part of the deterministic run id. */
  key: string;
  workflow: string;
  input?: unknown;
  /** Start one run every `everyMs`. Mutually exclusive with `cron`. */
  everyMs?: number;
  /**
   * A cron expression (5 fields `m h dom mon dow`, or 6 with leading seconds) evaluated in
   * {@link ScheduledWorkflow.timezone}. Mutually exclusive with `everyMs`. Needs the optional peer
   * dependency `cron-parser`.
   */
  cron?: string;
  /** IANA timezone the `cron` fires in (e.g. `America/Sao_Paulo`). Defaults to UTC. */
  timezone?: string;
  /** Temporarily stop firing this schedule (kept registered). Defaults to false. */
  paused?: boolean;
  /**
   * What to do when the previous window's run hasn't finished yet (fixed-interval schedules only):
   * `'allow'` (default) starts the new window anyway; `'skip'` skips it while the prior run is still
   * `running`/`suspended`, so a slow run can't pile up overlapping executions.
   */
  overlap?: 'allow' | 'skip';
}

/** Deterministic run id for a fixed-interval schedule's current time window. */
export function scheduledRunId(key: string, everyMs: number, nowMs: number): string {
  return `sched:${key}:${Math.floor(nowMs / everyMs)}`;
}

type CronParser = typeof import('cron-parser');
let cronParser: CronParser | undefined;
function loadCronParser(): CronParser {
  if (cronParser) return cronParser;
  try {
    // Lazy + optional: core stays dependency-free; only users who schedule by cron need this.
    cronParser = require('cron-parser') as CronParser;
  } catch {
    throw new Error(
      'cron schedules need the optional peer dependency "cron-parser" — install it (e.g. `npm i cron-parser`).',
    );
  }
  return cronParser;
}

/**
 * Epoch ms of the most recent cron fire at or before `nowMs`, evaluated in `timezone` (default UTC).
 * This is the deterministic "bucket" a cron run is keyed on, so polling repeatedly within an
 * interval resolves to the same fire time — and thus the same idempotent run id.
 */
export function prevCronFireMs(expr: string, nowMs: number, timezone = 'UTC'): number {
  const parser = loadCronParser();
  // `+1` makes a fire landing exactly on `nowMs` count as "at or before now", not the prior one.
  const it = parser.parseExpression(expr, { currentDate: new Date(nowMs + 1), tz: timezone });
  return it.prev().toDate().getTime();
}

/** The deterministic, idempotent run id for a schedule at `nowMs` — its current fire window. */
function scheduleRunIdAt(s: ScheduledWorkflow, nowMs: number): string {
  if (s.cron != null) return `sched:${s.key}:${prevCronFireMs(s.cron, nowMs, s.timezone)}`;
  if (s.everyMs != null) return scheduledRunId(s.key, s.everyMs, nowMs);
  throw new Error(`schedule "${s.key}" needs either "everyMs" or "cron"`);
}

/**
 * Start each schedule's current-window run. The run id is the time bucket (a fixed-interval index,
 * or the cron fire time) and `engine.start` is idempotent, so firing this on an interval — or
 * racing two instances on the same tick — starts **each window exactly once**. Wire it to a
 * `setInterval`, the durable timer poller, or `@nestjs/schedule`. Returns the run ids for the
 * current windows.
 */
export async function runSchedules(
  engine: Pick<WorkflowEngine, 'start' | 'getRun'>,
  schedules: readonly ScheduledWorkflow[],
  nowMs: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (const s of schedules) {
    if (s.paused) continue;
    // overlap:'skip' (fixed-interval): don't start this window while the previous window's run is
    // still in-flight, so a slow run can't pile up. Interval-only — cron windows aren't adjacent ids.
    if (s.overlap === 'skip' && s.everyMs) {
      const prevBucket = Math.floor(nowMs / s.everyMs) - 1;
      if (prevBucket >= 0) {
        const prev = await engine.getRun(`sched:${s.key}:${prevBucket}`);
        if (prev && (prev.status === 'running' || prev.status === 'suspended')) continue;
      }
    }
    const runId = scheduleRunIdAt(s, nowMs);
    await engine.start(s.workflow, s.input, runId);
    ids.push(runId);
  }
  return ids;
}
