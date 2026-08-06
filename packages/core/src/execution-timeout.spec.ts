import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('executionTimeout (sweepTimeouts)', () => {
  it('cancels an in-flight run older than its execution timeout, leaves younger ones', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('slow', '1', async () => undefined, { executionTimeout: '1h' });
    engine.register('untimed', '1', async () => undefined); // no timeout

    // A suspended run created at epoch 1000 (controls createdAt directly).
    const at = new Date(1000);
    await store.createRun({
      id: 'old',
      workflow: 'slow',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      createdAt: at,
      updatedAt: at,
    });
    await store.createRun({
      id: 'safe',
      workflow: 'untimed',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      createdAt: at,
      updatedAt: at,
    });

    // Before the 1h deadline → no-op.
    await engine.sweepTimeouts(1000 + 1_000_000);
    expect((await store.getRun('old'))?.status).toBe('suspended');

    // Past the 1h deadline → `old` is cancelled; the untimed `safe` run is untouched.
    await engine.sweepTimeouts(1000 + 3_700_000);
    const old = await store.getRun('old');
    expect(old?.status).toBe('cancelled');
    expect(old?.error?.code).toBe('execution_timeout');
    expect((await store.getRun('safe'))?.status).toBe('suspended');
  });
});

/**
 * A timed-out parent must take its subtree with it, exactly as an explicit `cancel` does. Before
 * this, `sweepTimeouts` wrote the parent's terminal status straight to the store and stopped there,
 * so its children kept running with nothing pointing at them — an orphan you could only find by
 * reading the runs table by hand.
 *
 * NOTHING in these cases gives a child a timeout of its own: only `parent` carries an
 * `executionTimeout`, so a child reaching a terminal state can ONLY be the cascade. Delete the
 * cascade and every one of these goes red.
 */
describe('executionTimeout — the cascade to children', () => {
  /** Wait until `runId` has settled into a non-executing state (suspended or terminal). */
  async function settled(store: InMemoryStateStore, runId: string) {
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setImmediate(r));
      const run = await store.getRun(runId);
      if (run && run.status !== 'pending' && run.status !== 'running') return run;
    }
    throw new Error(`run ${runId} never settled`);
  }

  /** parent → child → grandchild, each parked on a signal that never comes. Only `parent` is timed. */
  function tree(timeout = '1h') {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('grandchild', '1', async (ctx) => ctx.waitForSignal('never'));
    engine.register('child', '1', async (ctx) => {
      await ctx.startChild('grandchild', {}, 'gc');
      return ctx.waitForSignal('never');
    });
    engine.register(
      'parent',
      '1',
      async (ctx) => {
        await ctx.startChild('child', {}, 'c');
        return ctx.waitForSignal('never');
      },
      { executionTimeout: timeout },
    );
    return { store, engine };
  }

  it('cancels a live child — and the child of that child — when the parent times out', async () => {
    const { store, engine } = tree();

    await engine.start('parent', {}, 'p');
    for (const id of ['p', 'c', 'gc']) expect((await settled(store, id)).status).toBe('suspended');

    await engine.sweepTimeouts(Date.now() + 3_700_000);

    expect((await store.getRun('p'))?.status).toBe('cancelled');
    expect((await store.getRun('p'))?.error?.code).toBe('execution_timeout');
    // Depth: the cascade is the same recursive walk `cancel` uses, so it does not stop at depth 1.
    expect((await store.getRun('c'))?.status).toBe('cancelled');
    expect((await store.getRun('gc'))?.status).toBe('cancelled');
  });

  it('does not clobber a child that had already finished', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('quick', '1', async () => 'done');
    engine.register(
      'parent',
      '1',
      async (ctx) => {
        await ctx.startChild('quick', {}, 'done-child');
        return ctx.waitForSignal('never');
      },
      { executionTimeout: '1h' },
    );

    await engine.start('parent', {}, 'p');
    await settled(store, 'p');
    expect((await settled(store, 'done-child')).status).toBe('completed');

    await engine.sweepTimeouts(Date.now() + 3_700_000);

    expect((await store.getRun('p'))?.status).toBe('cancelled');
    // The terminal guard in `cancel` — a completed child keeps its output, it is not re-terminated.
    const child = await store.getRun('done-child');
    expect(child?.status).toBe('completed');
    expect(child?.output).toBe('done');
    expect(child?.error).toBeUndefined();
  });

  it('is idempotent when two pollers sweep the same run at once', async () => {
    const { store, engine } = tree();

    await engine.start('parent', {}, 'p');
    for (const id of ['p', 'c', 'gc']) await settled(store, id);

    const now = Date.now() + 3_700_000;
    // Two workers, same tick — neither may throw, and the second must not undo the first.
    await Promise.all([engine.sweepTimeouts(now), engine.sweepTimeouts(now)]);
    await engine.sweepTimeouts(now); // and a third, after the fact

    expect((await store.getRun('p'))?.status).toBe('cancelled');
    expect((await store.getRun('p'))?.error?.code).toBe('execution_timeout');
    expect((await store.getRun('c'))?.status).toBe('cancelled');
    expect((await store.getRun('gc'))?.status).toBe('cancelled');
  });

  it('terminates on a cyclic parent→child graph instead of recursing forever', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('looper', '1', async (ctx) => ctx.waitForSignal('never'), {
      executionTimeout: '1h',
    });
    // UNTIMED, so the sweep's own scan never touches `b` — reaching it is the cascade's doing alone.
    engine.register('partner', '1', async (ctx) => ctx.waitForSignal('never'));

    // A pathological graph: `a` awaits `b` and `b` awaits `a`. Written directly, because no workflow
    // body can produce it — the point is that the cascade survives it if a store ever does.
    const at = new Date(1000);
    const cycle: Array<{ id: string; workflow: string }> = [
      { id: 'a', workflow: 'looper' },
      { id: 'b', workflow: 'partner' },
    ];
    for (const { id, workflow } of cycle) {
      await store.createRun({
        id,
        workflow,
        workflowVersion: '1',
        status: 'suspended',
        input: {},
        createdAt: at,
        updatedAt: at,
      });
    }
    await store.putSignalWaiter({ token: 'child:b', runId: 'a', seq: 0 });
    await store.putSignalWaiter({ token: 'child:a', runId: 'b', seq: 0 });

    // The parent is written terminal BEFORE the cascade recurses, so the loop back into `a` hits
    // `cancel`'s already-cancelled guard and stops. No stack overflow, no hang.
    await engine.sweepTimeouts(1000 + 3_700_000);

    expect((await store.getRun('a'))?.status).toBe('cancelled');
    expect((await store.getRun('b'))?.status).toBe('cancelled');
  });
});
