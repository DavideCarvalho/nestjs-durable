import { WorkflowEngine } from './engine';
import type { EngineEvent, RunStatus, StateStore, WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A turn settles from a snapshot it read before running the body. If the run reached a terminal
 * state through another path while the body ran (an operator's `cancel()`, a timeout sweep, a
 * dead-letter), the turn's outcome must not overwrite it. The write is a compare-and-set on the run's
 * status (`StateStore.updateRunIf`), so the database, not a prior JS read, decides.
 */

function gate() {
  let hit!: () => void;
  const reached = new Promise<void>((r) => {
    hit = r;
  });
  let release!: () => void;
  const open = new Promise<void>((r) => {
    release = r;
  });
  return { reached, hit, release, open };
}

/** The in-memory store without `updateRunIf`, as a third-party store that predates it. */
function withoutCas(store: InMemoryStateStore): StateStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'updateRunIf') return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const variant of ['updateRunIf', 'fallback'] as const) {
  describe(`settling a turn never overwrites a terminal state reached meanwhile (${variant})`, () => {
    const make = () => {
      const inner = new InMemoryStateStore();
      const store = variant === 'fallback' ? withoutCas(inner) : inner;
      const engine = new WorkflowEngine({ store });
      const events: EngineEvent[] = [];
      engine.subscribe((e) => events.push(e));
      return { inner, store, engine, events };
    };

    it('a cancel landing while the body runs survives the turn completing', async () => {
      const { inner, engine, events } = make();
      const g = gate();
      engine.register('wf', '1', async (ctx) => {
        await ctx.localStep('slow', async () => {
          g.hit();
          await g.open;
        });
        return 'done';
      });
      const { runId } = await engine.start('wf', {}, 'r-cancel-vs-complete');
      await g.reached;
      expect((await engine.cancel(runId))?.status).toBe('cancelled');
      g.release();
      await engine.drain(5_000);

      expect((await inner.getRun(runId))?.status).toBe('cancelled');
      expect(events.some((e) => e.type === 'run.completed')).toBe(false);
    });

    it('a cancel landing while the body runs survives the turn failing', async () => {
      const { inner, engine, events } = make();
      const g = gate();
      engine.register('wf', '1', async (ctx) => {
        await ctx.localStep('slow', async () => {
          g.hit();
          await g.open;
          throw new Error('boom');
        });
        return 'done';
      });
      const { runId } = await engine.start('wf', {}, 'r-cancel-vs-fail');
      await g.reached;
      await engine.cancel(runId);
      g.release();
      await engine.drain(5_000);

      const run = await inner.getRun(runId);
      expect(run?.status).toBe('cancelled');
      expect(run?.error?.message).toBe('cancelled');
      expect(events.filter((e) => e.type === 'run.failed' && e.runId === runId)).toHaveLength(1);
    });

    it('a run dead-lettered while the body runs is not resurrected by a suspend', async () => {
      const { inner, engine } = make();
      const g = gate();
      engine.register('wf', '1', async (ctx) => {
        await ctx.localStep('slow', async () => {
          g.hit();
          await g.open;
        });
        await ctx.sleep(60_000);
        return 'done';
      });
      const { runId } = await engine.start('wf', {}, 'r-dead-vs-suspend');
      await g.reached;
      await inner.updateRun(runId, { status: 'dead' satisfies RunStatus, updatedAt: new Date() });
      g.release();
      await engine.drain(5_000);
      expect((await inner.getRun(runId))?.status).toBe('dead');
    });
  });
}

describe('StateStore.updateRunIf (in-memory)', () => {
  const base: WorkflowRun = {
    id: 'r1',
    workflow: 'wf',
    workflowVersion: '1',
    status: 'running',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it('applies the patch only when the status is one of the expected ones', async () => {
    const store = new InMemoryStateStore();
    await store.createRun(base);
    expect(await store.updateRunIf('r1', ['suspended'], { status: 'completed' })).toBe(false);
    expect((await store.getRun('r1'))?.status).toBe('running');
    expect(await store.updateRunIf('r1', ['running'], { status: 'completed', output: 1 })).toBe(
      true,
    );
    expect((await store.getRun('r1'))?.output).toBe(1);
    expect(await store.updateRunIf('missing', ['running'], { status: 'completed' })).toBe(false);
  });
});
