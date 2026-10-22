import * as core from '@dudousxd/nestjs-durable-core';
import type {
  RunStatus,
  StalledRunInfo,
  StateStore,
  StepCheckpoint,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';

/** Default `--stale` threshold: 15 minutes, the engine's `stalledAfterMs` default. */
export const DEFAULT_STALE_MS = 15 * 60_000;

export interface InspectOptions {
  /** Show one run's step timeline instead of the runs list. */
  runId?: string | undefined;
  /** Filter the runs list by status. */
  status?: RunStatus | undefined;
  /** Max runs to list. Defaults to 50. */
  limit?: number | undefined;
  /**
   * Show only the runs that look stranded, idle for at least this many ms (see `findStalledRuns`):
   * suspended with no wake timer, or parked on an old pending remote step nothing is leasing.
   */
  staleMs?: number | undefined;
  /** Restrict the listing to one namespace. */
  namespace?: string | undefined;
}

/** Render the runs list, or a single run's timeline, as plain text for the terminal. */
export async function inspect(store: StateStore, opts: InspectOptions): Promise<string> {
  if (opts.runId) {
    const run = await store.getRun(opts.runId);
    if (!run) return `Run ${opts.runId} not found.`;
    return runTimeline(run, await store.listCheckpoints(opts.runId));
  }
  if (opts.staleMs !== undefined) return staleTable(await listStale(store, opts));
  const runs = await store.listRuns({
    status: opts.status,
    limit: opts.limit ?? 50,
    ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
  });
  return runsTable(runs);
}

async function listStale(store: StateStore, opts: InspectOptions): Promise<StalledRunInfo[]> {
  // Optional at runtime: the peer range is wide, and an older core has no `findStalledRuns`.
  const find = (core as Partial<typeof core>).findStalledRuns;
  if (typeof find !== 'function') {
    throw new Error(
      '--stale needs a newer @dudousxd/nestjs-durable-core (one that exports findStalledRuns).',
    );
  }
  const stalled = await find(store, {
    thresholdMs: opts.staleMs,
    namespace: opts.namespace,
    scan: Math.max(opts.limit ?? 1_000, 1_000),
  });
  return stalled.slice(0, opts.limit ?? 50);
}

function staleTable(stalled: StalledRunInfo[]): string {
  if (stalled.length === 0) return 'No stranded runs.';
  const rows = stalled.map(({ run, ageMs, wakeForever, stalePending }) => [
    run.id,
    run.workflow,
    run.status,
    compactAge(ageMs),
    wakeForever
      ? 'suspended, no wake timer'
      : stalePending
        ? `step ${stalePending.seq} ${stalePending.name} pending ${compactAge(stalePending.ageMs)} (attempt ${stalePending.attempts})`
        : '-',
  ]);
  return [
    table(['RUN', 'WORKFLOW', 'STATUS', 'IDLE', 'WHY'], rows),
    '',
    'Recover a lost remote step with `engine.redispatchPending(runId)`, a wake-forever run with',
    '`engine.resume(runId)` (or deliver the signal/event it waits on), or cancel it: `durable cancel <runId>`.',
  ].join('\n');
}

/**
 * Parse a compact single-unit duration (`90s`, `15m`, `4h`, `2d`, `500ms`) into milliseconds, or
 * `undefined` for anything else.
 */
export function parseDurationMs(input: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) return undefined;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
  ];
  return Number(match[1]) * unit;
}

/**
 * A run's replayable history as a JSON fixture — the same format as the testing kit's
 * `serializeRunHistory` (`{ version, run, checkpoints }`, `version` being core's shared
 * `RUN_HISTORY_FIXTURE_VERSION`), so CI can assert it with
 * `assertReplayable(register, parseRunHistory(json))`. Returns `null` for an unknown run.
 */
export async function exportRun(store: StateStore, runId: string): Promise<string | null> {
  // Optional at runtime, like findStalledRuns: an older core (the peer range is wide) lacks it, and
  // guessing the version would let the two fixture writers drift apart.
  const version = (core as Partial<typeof core>).RUN_HISTORY_FIXTURE_VERSION;
  if (typeof version !== 'number') {
    throw new Error(
      'export needs a newer @dudousxd/nestjs-durable-core (one that exports RUN_HISTORY_FIXTURE_VERSION).',
    );
  }
  const run = await store.getRun(runId);
  if (!run) return null;
  const checkpoints = await store.listCheckpoints(runId);
  return `${JSON.stringify({ version, run, checkpoints }, null, 2)}\n`;
}

function runsTable(runs: WorkflowRun[]): string {
  if (runs.length === 0) return 'No runs.';
  const rows = runs.map((r) => [r.id, r.workflow, r.status, relTime(r.updatedAt)]);
  return table(['RUN', 'WORKFLOW', 'STATUS', 'UPDATED'], rows);
}

function runTimeline(run: WorkflowRun, steps: StepCheckpoint[]): string {
  const lines = [
    `${run.workflow}  [${run.status}]  v${run.workflowVersion}`,
    run.id,
    '',
    ...(steps.length === 0
      ? ['  (no steps recorded)']
      : steps.map((s) => {
          const group = s.workerGroup ? ` @${s.workerGroup}` : '';
          const tries = s.attempts > 1 ? `  ×${s.attempts}` : '';
          return `  ${s.seq}  ${s.name}  (${s.kind}${group})  ${s.status}  ${duration(s)}${tries}`;
        })),
  ];
  if (run.error) lines.push('', `error: ${run.error.message}`);
  return lines.join('\n');
}

/**
 * Soft-cancel a run from the terminal: marks it `cancelled` in the store so a suspended run won't
 * resume and the recovery/timer poller skips it. An in-flight step on another instance finishes its
 * current attempt first (cancellation is observed at the next checkpoint), so this is a request, not
 * a hard kill. Returns a status line.
 */
export async function cancelRun(store: StateStore, runId: string): Promise<string> {
  const run = await store.getRun(runId);
  if (!run) return `Run ${runId} not found.`;
  if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
    return `Run ${runId} is already ${run.status}; nothing to cancel.`;
  }
  await store.updateRun(runId, { status: 'cancelled', updatedAt: new Date() });
  return `Run ${runId} marked cancelled.`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

function duration(step: StepCheckpoint): string {
  const ms = step.finishedAt.getTime() - step.startedAt.getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function compactAge(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${total % 60}s`;
  return `${total}s`;
}

function relTime(date: Date): string {
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
