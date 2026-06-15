import type { DashboardSpec } from '@dudousxd/nestjs-telescope';

/**
 * The "Workflows" health dashboard. `runHref` is a URL template for deep-linking a run
 * out to the durable dashboard (e.g. '/durable/runs/{runId}').
 */
export function durableDashboard(opts: { runHref?: string } = {}): DashboardSpec {
  const runHref = opts.runHref ?? '/durable/runs/{runId}';
  return {
    id: 'durable.workflows',
    label: 'Workflows',
    panels: [
      { kind: 'stat', title: 'Success rate', data: { provider: 'durable.timeseries', query: { metric: 'successRate' } }, format: 'percent', accent: 'text-emerald-400' },
      { kind: 'stat', title: 'Failed (window)', data: { provider: 'durable.timeseries', query: { metric: 'failed' } }, accent: 'text-red-400' },
      { kind: 'stat', title: 'Dead now', data: { provider: 'durable.state', query: { status: 'dead' } }, accent: 'text-red-400' },
      { kind: 'stat', title: 'Suspended now', data: { provider: 'durable.state', query: { status: 'suspended' } } },
      { kind: 'stat', title: 'Running now', data: { provider: 'durable.state', query: { status: 'running' } } },
      { kind: 'stat', title: 'Pending now', data: { provider: 'durable.state', query: { status: 'pending' } } },
      { kind: 'topN', title: 'Top failing workflows', data: { provider: 'durable.timeseries', query: { metric: 'topFailures' } }, limit: 10 },
      { kind: 'table', title: 'Recent failed runs', data: { provider: 'durable.recentFailures' },
        columns: [
          { key: 'workflow', label: 'Workflow' },
          { key: 'runId', label: 'Run', link: { href: runHref } },
          { key: 'error', label: 'Error' },
        ] },
    ],
  };
}
