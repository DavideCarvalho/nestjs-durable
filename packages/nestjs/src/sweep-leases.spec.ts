import 'reflect-metadata';
import {
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { type INestApplicationContext, Injectable } from '@nestjs/common';
import { InMemoryLockStore, LocksModule, LocksStorage } from '@nestjs/locks';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableModule } from './durable.module';

/**
 * Two pods of one app. With `LocksModule` sharing one lock store, the fleet-wide sweeps (retention,
 * the stalled-run pager, the buffered-signal cleanup) run on one of them; without it, on both.
 */

const sharedLocks = new InMemoryLockStore();

@Injectable()
class SharedLockStore {
  constructor(storage: LocksStorage) {
    storage.registerSource(sharedLocks);
  }
}

interface Pod {
  app: INestApplicationContext;
  prunes: () => number;
  stalledSweeps: () => number;
  bufferedSweeps: () => number;
}

async function pod(withLocks: boolean): Promise<Pod> {
  const store = new InMemoryStateStore();
  let prunes = 0;
  (store as { pruneTerminalRuns?: unknown }).pruneTerminalRuns = async () => {
    prunes += 1;
    return 0;
  };
  const mod = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store,
        transport: new InMemoryTransport(),
        timerPollMs: 20,
        retention: { sweepInterval: 20, policies: [{ statuses: ['completed'], maxAge: '1d' }] },
      }),
      ...(withLocks ? [LocksModule.forRoot()] : []),
    ],
    providers: withLocks ? [SharedLockStore] : [],
  }).compile();
  const engine = mod.get(WorkflowEngine);
  const stalled = vi.spyOn(engine, 'sweepStalled');
  const buffered = vi.spyOn(engine, 'sweepBufferedSignals');
  await mod.init();
  return {
    app: mod,
    prunes: () => prunes,
    stalledSweeps: () => stalled.mock.calls.length,
    bufferedSweeps: () => buffered.mock.calls.length,
  };
}

const ticks = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

const open: INestApplicationContext[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

describe('fleet-wide sweeps and @nestjs/locks (detected)', () => {
  it('with LocksModule and a shared store, one of two pods sweeps', async () => {
    const a = await pod(true);
    const b = await pod(true);
    open.push(a.app, b.app);
    await ticks();

    // Each sweep has its own lease, so different sweeps may land on different pods; each one runs
    // on exactly one of them.
    for (const count of ['prunes', 'stalledSweeps', 'bufferedSweeps'] as const) {
      const sweepers = [a, b].filter((p) => p[count]() > 0);
      expect(sweepers, count).toHaveLength(1);
      if (count !== 'prunes') expect(sweepers[0]?.[count](), count).toBeGreaterThan(1);
    }
  });

  it('when the sweeping pod shuts down, the other takes over', async () => {
    const a = await pod(true);
    const b = await pod(true);
    await ticks();
    const leader = a.prunes() > 0 ? a : b;
    const follower = leader === a ? b : a;
    open.push(follower.app);
    await leader.app.close(); // `Locks` hands its leases back at shutdown
    const before = follower.prunes();
    await ticks();
    expect(follower.prunes()).toBeGreaterThan(before);
  });

  it('without LocksModule, both pods sweep as before', async () => {
    const a = await pod(false);
    const b = await pod(false);
    open.push(a.app, b.app);
    await ticks();
    for (const p of [a, b]) {
      expect(p.prunes()).toBeGreaterThan(0);
      expect(p.stalledSweeps()).toBeGreaterThan(0);
      expect(p.bufferedSweeps()).toBeGreaterThan(0);
    }
  });
});
