import type { DashboardSpec } from '@dudousxd/nestjs-telescope';

/**
 * The "Workflows" health dashboard — golden-signals sections layout.
 *
 * `runHref` is a URL template for deep-linking a run out to the durable dashboard
 * (e.g. '/durable/runs/{runId}'). `recentFailuresWindowMs` bounds the "Stuck runs"
 * table (default 24h) so a healthy system shows an empty table instead of
 * days-old failures; pass `0` to show all.
 */
export function durableDashboard(
  opts: { runHref?: string; recentFailuresWindowMs?: number } = {},
): DashboardSpec {
  const runHref = opts.runHref ?? '/durable/runs/{runId}';
  const windowMs = opts.recentFailuresWindowMs ?? 24 * 60 * 60 * 1000;
  return {
    id: 'durable.workflows',
    label: 'Workflows',
    panels: [],
    sections: [
      {
        title: 'Health',
        cols: 4,
        panels: [
          {
            kind: 'gauge',
            title: 'Success rate',
            data: { provider: 'durable.successRate' },
            max: 1,
            format: 'percent',
            thresholds: { warn: 0.98, bad: 0.95, direction: 'down-bad' },
          },
          {
            kind: 'stat',
            title: 'Duration p95',
            data: { provider: 'durable.duration', query: { metric: 'p95' } },
            format: 'duration',
            spark: false,
            thresholds: { warn: 2000, bad: 5000, direction: 'up-bad' },
          },
          {
            kind: 'stat',
            title: 'Backlog',
            data: { provider: 'durable.state', query: { status: 'pending' } },
            spark: false,
            thresholds: { warn: 50, bad: 200, direction: 'up-bad' },
          },
          {
            kind: 'stat',
            title: 'Throughput',
            data: { provider: 'durable.throughput' },
            format: 'rate',
            spark: true,
          },
        ],
      },
      {
        title: 'Needs attention',
        cols: 3,
        panels: [
          {
            kind: 'topN',
            title: 'Top failing workflows',
            data: { provider: 'durable.timeseries', query: { metric: 'topFailures' } },
            limit: 8,
          },
          {
            kind: 'table',
            title: 'Stuck runs',
            data: { provider: 'durable.recentFailures', query: { windowMs } },
            columns: [
              { key: 'updatedAt', label: 'Updated' },
              { key: 'workflow', label: 'Workflow' },
              { key: 'runId', label: 'Run', link: { href: runHref } },
              { key: 'error', label: 'Error' },
            ],
          },
          {
            kind: 'table',
            // Lists ALL worker groups (starved ones sorted first); the Status column
            // flags STARVED (queued > 0 with zero live workers) vs ok. Titling it
            // "Starved worker groups" read as if every listed group were starved.
            title: 'Worker health',
            data: { provider: 'durable.workerHealth' },
            columns: [
              { key: 'group', label: 'Group' },
              { key: 'queued', label: 'Queued' },
              { key: 'liveWorkers', label: 'Workers' },
              { key: 'status', label: 'Status' },
            ],
          },
        ],
      },
      {
        title: 'Workers',
        cols: 2,
        panels: [
          {
            kind: 'table',
            // One row per LIVE worker (flattened from each group's heartbeats), exposing the live
            // WorkerStatus the heartbeat carries: fixed vs. adaptive limit, in-flight saturation,
            // RAM%/CPU%, throughput, p95, and why the adaptive controller last moved. A worker from
            // an older SDK with no status still lists, with '—' in the measured columns. The
            // adaptive min–max range rides the In-flight column's row value (`minMax` key) for those
            // that want it; the visible columns stay readable.
            title: 'Workers',
            data: { provider: 'durable.workerStatus' },
            columns: [
              { key: 'group', label: 'Group' },
              { key: 'instanceId', label: 'Worker' },
              { key: 'mode', label: 'Mode' },
              { key: 'limit', label: 'Limit' },
              { key: 'saturation', label: 'In-flight' },
              { key: 'queued', label: 'Queued' },
              { key: 'rssPct', label: 'RAM %' },
              { key: 'cpuPct', label: 'CPU %' },
              { key: 'throughputPerMin', label: 'Thrpt/min' },
              { key: 'p95Ms', label: 'p95 ms' },
              { key: 'lastAdjust', label: 'Last adjust' },
            ],
          },
        ],
      },
      {
        title: 'Trends',
        cols: 3,
        panels: [
          {
            kind: 'timeseries',
            title: 'Runs over time',
            data: { provider: 'durable.runsOverTime' },
            series: ['done', 'failed'],
            style: 'stacked',
          },
          {
            kind: 'distribution',
            title: 'Duration distribution',
            data: { provider: 'durable.duration' },
            markers: ['p50', 'p95', 'p99'],
            format: 'duration',
          },
          {
            kind: 'breakdown',
            title: 'Runs by state',
            data: { provider: 'durable.stateBreakdown' },
            style: 'donut',
          },
        ],
      },
    ],
  };
}
