import type { RetentionPolicy, StateStore } from '@dudousxd/nestjs-durable-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableModuleOptions, DurableRetentionOptions } from './durable.module';
import { RetentionPoller, validateRetention } from './retention-poller';

/** A store exposing only `pruneTerminalRuns`; the poller touches nothing else. */
function fakeStore(prune?: StateStore['pruneTerminalRuns']): StateStore {
  return { pruneTerminalRuns: prune } as unknown as StateStore;
}
function makePoller(store: StateStore, retention?: DurableRetentionOptions, worker?: boolean) {
  const options = { store, retention, worker } as unknown as DurableModuleOptions;
  return new RetentionPoller(store, options);
}

describe('validateRetention', () => {
  it('accepts disjoint terminal policies with at least one bound', () => {
    expect(() =>
      validateRetention({
        policies: [
          { statuses: ['completed', 'cancelled'], maxAge: 1000, maxCount: 10 },
          { statuses: ['failed'], maxAge: 2000 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a non-terminal status', () => {
    expect(() =>
      validateRetention({ policies: [{ statuses: ['running'], maxAge: 1 } as RetentionPolicy] }),
    ).toThrow(/not terminal/);
  });

  it('rejects overlapping status sets across policies', () => {
    expect(() =>
      validateRetention({
        policies: [
          { statuses: ['completed'], maxAge: 1 },
          { statuses: ['completed'], maxCount: 1 },
        ],
      }),
    ).toThrow(/disjoint/);
  });

  it('rejects a policy with no bound', () => {
    expect(() =>
      validateRetention({ policies: [{ statuses: ['completed'] } as RetentionPolicy] }),
    ).toThrow(/maxAge and\/or maxCount/);
  });

  it('rejects an unparseable maxAge duration string (fail fast)', () => {
    expect(() =>
      validateRetention({ policies: [{ statuses: ['completed'], maxAge: '1 month' }] }),
    ).toThrow(/duration/);
  });

  it('accepts an ms-style maxAge string', () => {
    expect(() =>
      validateRetention({ policies: [{ statuses: ['completed'], maxAge: '30d' }] }),
    ).not.toThrow();
  });
});

describe('RetentionPoller', () => {
  afterEach(() => vi.restoreAllMocks());

  const onePolicy: DurableRetentionOptions = {
    sweepInterval: 0, // run once on boot, no interval
    batchSize: 2,
    policies: [{ statuses: ['completed'], maxAge: 1000 }],
  };

  it('drains a policy in batches until a short batch comes back', async () => {
    // 2, 2, 1 -> stop after the short batch.
    const sizes = [2, 2, 1];
    const prune = vi.fn(async () => sizes.shift() ?? 0);
    const poller = makePoller(fakeStore(prune), onePolicy);

    await poller.onApplicationBootstrap();

    expect(prune).toHaveBeenCalledTimes(3);
    expect(prune.mock.calls[0]?.[2]).toBe(2); // batchSize forwarded as the limit
  });

  it('does not prune on a dashboard-only (worker:false) instance', async () => {
    const prune = vi.fn(async () => 0);
    const poller = makePoller(fakeStore(prune), onePolicy, false);

    await poller.onApplicationBootstrap();

    expect(prune).not.toHaveBeenCalled();
  });

  it('no-ops (warns) when the store does not implement pruneTerminalRuns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = makePoller(fakeStore(undefined), onePolicy);

    await expect(poller.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
  });

  it('is a no-op when no retention is configured', async () => {
    const prune = vi.fn(async () => 0);
    const poller = makePoller(fakeStore(prune), undefined);

    await poller.onApplicationBootstrap();

    expect(prune).not.toHaveBeenCalled();
  });

  it('throws on an invalid config at boot (fail fast)', async () => {
    const poller = makePoller(
      fakeStore(async () => 0),
      {
        policies: [{ statuses: ['running'], maxAge: 1 } as RetentionPolicy],
      },
    );

    await expect(poller.onApplicationBootstrap()).rejects.toThrow(/not terminal/);
  });
});
