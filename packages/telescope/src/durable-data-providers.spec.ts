import { describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { durableStateProvider, durableRecentFailuresProvider } from './durable-data-providers.js';

// Minimal fake store: only listRuns is exercised.
function fakeStore(byStatus: Record<string, unknown[]>) {
  return {
    listRuns: async ({ status }: { status?: string }) => (status ? (byStatus[status] ?? []) : []),
  };
}

function ctxWith(store: unknown): ExtensionContext {
  return {
    config: {} as ExtensionContext['config'],
    moduleRef: { get: () => store } as unknown as ExtensionContext['moduleRef'],
  };
}

describe('durableStateProvider', () => {
  it('defaults to counting dead runs', async () => {
    const provider = durableStateProvider();
    const result = (await provider.resolve(undefined, ctxWith(
      fakeStore({ dead: [{ id: 'd1' }, { id: 'd2' }], running: [{ id: 'r1' }] }),
    ))) as { value: number };
    expect(result.value).toBe(2);
  });

  it('counts the requested status', async () => {
    const provider = durableStateProvider();
    const result = (await provider.resolve({ status: 'running' }, ctxWith(
      fakeStore({ dead: [{ id: 'd1' }], running: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] }),
    ))) as { value: number };
    expect(result.value).toBe(3);
  });
});

describe('durableRecentFailuresProvider', () => {
  it('returns failed+dead runs as rows, newest first', async () => {
    const provider = durableRecentFailuresProvider();
    const store = {
      listRuns: async ({ status }: { status?: string }) =>
        status === 'failed'
          ? [{ id: 'f1', workflow: 'checkout', error: { message: 'boom' }, updatedAt: new Date(1000) }]
          : status === 'dead'
            ? [{ id: 'd1', workflow: 'ship', error: { message: 'dead' }, updatedAt: new Date(2000) }]
            : [],
    };
    const result = (await provider.resolve(undefined, ctxWith(store))) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toEqual({ workflow: 'ship', runId: 'd1', error: 'dead' });
    expect(result.rows[1]).toEqual({ workflow: 'checkout', runId: 'f1', error: 'boom' });
  });
});
