import { defineTelescopeExtension } from '@dudousxd/nestjs-telescope';
import { DurableTelescopeWatcher } from './durable-telescope.watcher';
import {
  durableRecentFailuresProvider,
  durableStateProvider,
  durableTimeseriesProvider,
} from './durable-data-providers';
import { durableDashboard } from './durable-dashboard.spec-data';

/** The first-class Telescope extension for nestjs-durable: watcher + Workflows dashboard. */
export function durableTelescopeExtension(
  opts: { runHref?: string; recentFailuresWindowMs?: number } = {},
) {
  return defineTelescopeExtension({
    name: 'durable',
    watchers: () => [new DurableTelescopeWatcher()],
    entryTypes: () => [{ id: 'durable', label: 'Workflows', dot: 'bg-amber-400' }],
    dashboards: () => [durableDashboard(opts)],
    dataProviders: () => [
      durableStateProvider(),
      durableTimeseriesProvider(),
      durableRecentFailuresProvider(),
    ],
  });
}
