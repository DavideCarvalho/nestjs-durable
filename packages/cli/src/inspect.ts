import type {
  RunStatus,
  StateStore,
  StepCheckpoint,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';

export interface InspectOptions {
  /** Show one run's step timeline instead of the runs list. */
  runId?: string;
  /** Filter the runs list by status. */
  status?: RunStatus;
  /** Max runs to list. Defaults to 50. */
  limit?: number;
}

/** Render the runs list, or a single run's timeline, as plain text for the terminal. */
export async function inspect(store: StateStore, opts: InspectOptions): Promise<string> {
  if (opts.runId) {
    const run = await store.getRun(opts.runId);
    if (!run) return `Run ${opts.runId} not found.`;
    return runTimeline(run, await store.listCheckpoints(opts.runId));
  }
  const runs = await store.listRuns({ status: opts.status, limit: opts.limit ?? 50 });
  return runsTable(runs);
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

function relTime(date: Date): string {
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
