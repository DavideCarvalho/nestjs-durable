import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const run = (id: string, status: 'pending' | 'running', createdAt = new Date()) => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status,
  input: {},
  createdAt,
  updatedAt: createdAt,
});

describe('drain stops new work', () => {
  it('[drain-lock-recheck] releases a lease taken while drain began, instead of starting the run', async () => {
    const inner = new InMemoryStateStore();
    const holder: { engine?: WorkflowEngine } = {};
    let bodyRuns = 0;
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'tryLockRun') return typeof value === 'function' ? value.bind(target) : value;
        return async (...args: Parameters<typeof inner.tryLockRun>) => {
          const got = await inner.tryLockRun(...args);
          holder.engine?.beginDrain(); // drain lands while the lock is being taken
          return got;
        };
      },
    });
    const engine = new WorkflowEngine({ store });
    holder.engine = engine;
    engine.register('wf', '1', async () => {
      bodyRuns += 1;
    });
    await inner.createRun(run('r1', 'pending'));

    const results = await engine.runPending();

    expect(results).toEqual([]);
    expect(bodyRuns).toBe(0);
    // the lease was handed back, so another instance can take the run at once
    expect(await inner.tryLockRun('r1', 'other', Date.now() + 60_000, Date.now())).toBe(true);
  });

  it('[drain-recover] recoverIncomplete locks nothing once draining', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => {});
    await store.createRun(run('r1', 'running'));
    const lock = vi.spyOn(store, 'tryLockRun');
    engine.beginDrain();
    expect(await engine.recoverIncomplete()).toEqual([]);
    expect(lock).not.toHaveBeenCalled();
  });

  it('[drain-sweep] sweepTimeouts cancels nothing once draining', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => {}, { executionTimeout: '1h' });
    await store.createRun(run('r1', 'running', new Date(Date.now() - 2 * 3_600_000)));
    engine.beginDrain();
    await engine.sweepTimeouts();
    expect((await store.getRun('r1'))?.status).toBe('running');
  });

  it('[drain-deadline] drain() is charged for time spent waiting on the poll, not for time that merely passes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', () => new Promise<void>(() => {})); // never finishes
    await engine.start('wf', {}, 'r1');

    // Poller destroyed with no poll waited on: a long gap (other hooks, HTTP close) costs nothing.
    engine.beginDrain();
    await new Promise((r) => setTimeout(r, 150));
    let started = Date.now();
    await engine.drain(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150); // the full 200ms budget was available

    // Time actually spent waiting on the poll IS deducted.
    engine.beginDrain(150);
    started = Date.now();
    await engine.drain(200);
    expect(Date.now() - started).toBeLessThan(150); // only ~50ms left of the 200ms
  });
});
