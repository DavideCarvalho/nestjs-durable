import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { durableTelescopeExtension } from './durable-telescope.extension';

const ctx = { config: {}, moduleRef: {} } as unknown as ExtensionContext;

describe('durableTelescopeExtension', () => {
  it('bundles the watcher, entry type, dashboard, and all providers', () => {
    const ext = durableTelescopeExtension();
    expect(ext.name).toBe('durable');
    expect(ext.watchers?.(ctx).map((w) => w.type)).toEqual(['durable']);
    expect(ext.entryTypes?.(ctx)).toEqual([
      { id: 'durable', label: 'Workflows', dot: 'bg-amber-400' },
    ]);
    expect(ext.dashboards?.(ctx).map((d) => d.id)).toEqual(['durable.workflows']);
    expect(
      ext
        .dataProviders?.(ctx)
        .map((p) => p.name)
        .sort(),
    ).toEqual([
      'durable.duration',
      'durable.recentFailures',
      'durable.runsOverTime',
      'durable.state',
      'durable.stateBreakdown',
      'durable.successRate',
      'durable.throughput',
      'durable.timeseries',
      'durable.workerHealth',
      'durable.workerStatus',
    ]);
  });
});
