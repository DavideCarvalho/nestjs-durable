import { describe, expect, it } from 'vitest';
import { ExtensionRegistry } from '@dudousxd/nestjs-telescope';
import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { InMemoryStateStore, WorkflowEngine, STATE_STORE } from '@dudousxd/nestjs-durable-core';
import { durableTelescopeExtension } from './durable-telescope.extension';

function ctxResolving(map: Map<unknown, unknown>): ExtensionContext {
  return {
    config: {} as ExtensionContext['config'],
    moduleRef: { get: (token: unknown) => map.get(token) } as unknown as ExtensionContext['moduleRef'],
  };
}

describe('durable extension integrates with the real Telescope ExtensionRegistry', () => {
  it('registers the durable entry type, dashboard, and providers without collision', () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const ctx = ctxResolving(
      new Map<unknown, unknown>([
        [STATE_STORE, store],
        [WorkflowEngine, engine],
      ]),
    );
    const registry = new ExtensionRegistry([durableTelescopeExtension()], ctx);

    expect(registry.watchers().map((w) => w.type)).toEqual(['durable']);
    expect(registry.entryTypes().map((e) => e.id)).toContain('durable');
    expect(registry.dashboards().map((d) => d.id)).toContain('durable.workflows');
    expect(registry.findProvider('durable.state')).toBeDefined();
    expect(registry.findProvider('durable.timeseries')).toBeDefined();
    expect(registry.findProvider('durable.recentFailures')).toBeDefined();
  });

  it('resolves durable.state against a real (empty) store to 0', async () => {
    const store = new InMemoryStateStore();
    const ctx = ctxResolving(new Map<unknown, unknown>([[STATE_STORE, store]]));
    const registry = new ExtensionRegistry([durableTelescopeExtension()], ctx);

    const provider = registry.findProvider('durable.state');
    expect(provider).toBeDefined();
    const result = (await provider!.resolve({ status: 'dead' }, ctx)) as { value: number };
    expect(result.value).toBe(0);
  });

  it('resolves the dashboard panels to known providers (no dangling bindings)', () => {
    const ctx = ctxResolving(new Map());
    const registry = new ExtensionRegistry([durableTelescopeExtension()], ctx);
    const dash = registry.dashboards().find((d) => d.id === 'durable.workflows');
    expect(dash).toBeDefined();
    const providerNames = new Set(['durable.state', 'durable.timeseries', 'durable.recentFailures']);
    for (const panel of dash!.panels) {
      expect(providerNames.has(panel.data.provider)).toBe(true);
    }
  });
});
