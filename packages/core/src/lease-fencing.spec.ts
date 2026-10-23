import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noDispatch = { dispatch: () => {} };

function slowEngine(
  store: InMemoryStateStore,
  instanceId: string,
  stepMs: number,
  ran: { count: number },
) {
  const engine = new WorkflowEngine({
    store,
    instanceId,
    leaseMs: 100,
    runDispatcher: noDispatch,
  });
  engine.register('slow', '1', async (ctx) => {
    const out = await ctx.localStep('work', async () => {
      ran.count += 1;
      await sleep(stepMs);
      return `done-by-${instanceId}`;
    });
    return out;
  });
  return engine;
}

describe('lease takeover fencing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a turn whose lease renewal reports a takeover does not write the run outcome', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryStateStore();
    const ran = { count: 0 };
    const e1 = slowEngine(store, 'e1', 300, ran);
    await e1.start('slow', {}, 'r1');
    const running = e1.runOne('r1');
    await sleep(20);
    expect((await store.getRun('r1'))?.lockedBy).toBe('e1');

    // e1 stalls past expiry and e2 takes the run over (it is re-executing it: still `running`).
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'e2', Date.now() + 60_000, Date.now())).toBe(true);

    const result = await running;
    expect(ran.count).toBe(1);
    // The zombie's "completed" was never written: the store still shows the new owner's state…
    const run = await store.getRun('r1');
    expect(run?.status).toBe('running');
    expect(run?.output).toBeUndefined();
    expect(result.status).toBe('running');
    // …and the zombie did not release the new owner's lease.
    expect(run?.lockedBy).toBe('e2');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('lost the lease of run r1'));
  });

  it('an execution that keeps its lease settles normally', async () => {
    const store = new InMemoryStateStore();
    const ran = { count: 0 };
    const e1 = slowEngine(store, 'e1', 250, ran);
    await e1.start('slow', {}, 'r1');
    const result = await e1.runOne('r1');
    expect(result?.status).toBe('completed');
    expect((await store.getRun('r1'))?.output).toBe('done-by-e1');
    expect((await store.getRun('r1'))?.lockedBy).toBeUndefined();
  });

  it('the fence is per execution: the next execution on the same instance is not fenced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryStateStore();
    const ran = { count: 0 };
    const e1 = slowEngine(store, 'e1', 200, ran);
    await e1.start('slow', {}, 'r1');
    const running = e1.runOne('r1');
    await sleep(20);
    await store.releaseRunLock('r1');
    await store.tryLockRun('r1', 'e2', Date.now() + 60_000, Date.now());
    await running;
    // e2 "crashes" (its lease is gone) and e1 picks the run up again: this time it settles.
    await store.releaseRunLock('r1');
    const again = await e1.resume('r1');
    expect(again.status).toBe('completed');
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });
});

describe('drain() releases leases on timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases the lease of a run still executing when the budget ends, and fences that turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryStateStore();
    const ran = { count: 0 };
    const e1 = slowEngine(store, 'e1', 400, ran);
    const e2 = slowEngine(store, 'e2', 10, ran);
    await e1.start('slow', {}, 'r1');
    const running = e1.runOne('r1');
    await sleep(20);
    expect((await store.getRun('r1'))?.lockedBy).toBe('e1');

    await e1.drain(50);
    // Released right away: no waiting out `leaseMs` before another instance can recover it.
    expect((await store.getRun('r1'))?.lockedBy).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('released their leases'));

    const recovered = await e2.recoverIncomplete();
    expect(recovered.map((r) => r.runId)).toContain('r1');
    // Recovery re-enqueues it (the dispatcher here is a no-op); e2 then drives it.
    await e2.runOne('r1');
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect((await store.getRun('r1'))?.output).toBe('done-by-e2');

    // The drained turn finishes later and writes nothing over e2's result.
    await running;
    expect((await store.getRun('r1'))?.output).toBe('done-by-e2');
  });

  it('releases nothing when in-flight runs settle within the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryStateStore();
    const ran = { count: 0 };
    const e1 = slowEngine(store, 'e1', 30, ran);
    await e1.start('slow', {}, 'r1');
    const running = e1.runOne('r1');
    await sleep(5);
    await e1.drain(2_000);
    await running;
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('released their leases'));
  });

  it('does not clear a lease another instance took over (owner-scoped release)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new InMemoryStateStore();
    const ran = { count: 0 };
    const e1 = slowEngine(store, 'e1', 300, ran);
    await e1.start('slow', {}, 'r1');
    const running = e1.runOne('r1');
    await sleep(20);
    // The takeover lands between renewals, so e1 has not noticed it yet when it drains.
    await store.releaseRunLock('r1');
    await store.tryLockRun('r1', 'e2', Date.now() + 60_000, Date.now());
    await e1.drain(10);
    expect((await store.getRun('r1'))?.lockedBy).toBe('e2');
    await running;
    expect((await store.getRun('r1'))?.lockedBy).toBe('e2');
  });
});

describe('lease takeover fencing on the remote cancelling settle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a fenced turn neither emits nor notifies the cancel the new owner will settle', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The `cancelled` write stalls past expiry; meanwhile e2 takes the run over.
    class SlowCancelStore extends InMemoryStateStore {
      override async updateRun(
        runId: string,
        patch: Parameters<InMemoryStateStore['updateRun']>[1],
      ): Promise<void> {
        if (patch.status === 'cancelled') {
          await this.releaseRunLock(runId);
          await this.tryLockRun(runId, 'e2', Date.now() + 60_000, Date.now());
          await sleep(150); // > leaseMs / 2: e1's renewal runs, reports the lease lost
        }
        return super.updateRun(runId, patch);
      }
    }
    const store = new SlowCancelStore();
    const engine = new WorkflowEngine({
      store,
      instanceId: 'e1',
      leaseMs: 100,
      runDispatcher: noDispatch,
    });
    engine.registerRemote('remote-wf', '1', {
      group: 'py',
      executor: {
        async advance() {
          throw new Error('a cancelling run must not be advanced');
        },
      },
    });
    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'remote-wf',
      workflowVersion: '1',
      status: 'cancelling',
      input: {},
      createdAt: now,
      updatedAt: now,
    });
    const events: string[] = [];
    engine.subscribe((e) => {
      if (e.runId === 'r1') events.push(e.type);
    });
    const cancelled: string[] = [];
    engine.onCancel((runId) => cancelled.push(runId));

    await engine.runOne('r1');
    expect(events).not.toContain('run.failed');
    expect(cancelled).toEqual([]);
    expect((await store.getRun('r1'))?.lockedBy).toBe('e2');
  });
});
