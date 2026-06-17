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
            title: 'Starved worker groups',
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
