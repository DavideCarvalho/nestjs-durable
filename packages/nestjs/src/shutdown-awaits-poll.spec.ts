import {
  InMemoryStateStore,
  InMemoryTransport,
  type StateStore,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Workflow({ name: 'shutdown-job', version: '1' })
class ShutdownJob {
  async run() {
    return 1;
  }
}

/**
 * The timer poll runs on an interval and is not tracked by the engine's in-flight set, so a close
 * that arrives mid-poll used to return while the poll kept calling the store (and, over a backlog,
 * kept leasing runs). These specs hold a store call open, close the app, and then check that the
 * poll locked nothing more and that no store call happened after `close()` resolved.
 */
function instrument(store: InMemoryStateStore, block: string, override: Partial<StateStore> = {}) {
  const state = {
    armed: false,
    closed: false,
    calls: [] as string[],
    afterClose: [] as string[],
    blocked: undefined as Promise<void> | undefined,
    release: () => {},
    reached: undefined as Promise<void> | undefined,
  };
  let reachedResolve = () => {};
  state.reached = new Promise<void>((r) => {
    reachedResolve = r;
  });
  const gate = new Promise<void>((r) => {
    state.release = r;
  });
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const overridden = (override as Record<string | symbol, unknown>)[prop];
      const value = overridden ?? Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return async (...args: unknown[]) => {
        if (state.closed) state.afterClose.push(prop);
        if (state.armed) state.calls.push(prop);
        if (state.armed && prop === block) {
          reachedResolve();
          await gate;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as StateStore;
  return { state, proxy };
}

async function boot(proxy: StateStore, extra: Record<string, unknown> = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: proxy,
        transport: new InMemoryTransport(),
        timerPollMs: 20,
        shutdownTimeoutMs: 3_000,
        ...extra,
      }),
    ],
    providers: [ShutdownJob],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('shutdown waits for the in-flight timer poll', () => {
  it('[shutdown-awaits-poll] locks no further run once close begins, and touches the store no more after close resolves', async () => {
    const backlog = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}` }));
    const { state, proxy } = instrument(new InMemoryStateStore(), 'tryLockRun', {
      listPendingRuns: async () => (state.armed ? (backlog as never) : []),
      tryLockRun: async () => false,
    });
    const moduleRef = await boot(proxy);
    state.armed = true;
    await state.reached; // the poll is inside the first tryLockRun

    const closing = moduleRef.close().then(() => {
      state.closed = true;
    });
    await new Promise((r) => setTimeout(r, 50)); // close must still be waiting on the poll
    expect(state.closed).toBe(false);
    state.release();
    await closing;
    await new Promise((r) => setTimeout(r, 100));

    expect(state.calls.filter((c) => c === 'tryLockRun')).toHaveLength(1);
    expect(state.afterClose).toEqual([]);
  });

  it('[shutdown-awaits-poll] fires no persisted schedule once close begins', async () => {
    const raw = new InMemoryStateStore();
    const { state, proxy } = instrument(raw, 'listSchedules');
    const moduleRef = await boot(proxy, { persistedSchedules: true });
    const engine = moduleRef.get(WorkflowEngine);
    state.armed = true;
    await engine.schedules.create({ id: 'due', workflow: ShutdownJob, every: 20 });
    await state.reached; // the poll's tick is inside the (blocked) listSchedules
    await new Promise((r) => setTimeout(r, 60)); // the schedule becomes due while the tick is held
    const due = await raw.listSchedules?.({ dueBy: Date.now() });
    expect(due?.length).toBeGreaterThan(0); // precondition: the block is real, the tick WOULD fire it
    state.calls.length = 0;

    const closing = moduleRef.close().then(() => {
      state.closed = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(state.closed).toBe(false); // close() is still waiting on the blocked tick
    state.release();
    await closing;
    await new Promise((r) => setTimeout(r, 100));

    expect(state.calls).not.toContain('updateSchedule');
    expect(state.calls).not.toContain('createRun');
    expect(state.afterClose).toEqual([]);
  });
});
