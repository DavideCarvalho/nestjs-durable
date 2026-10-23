import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StepCheckpoint } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred: () => Promise<boolean>, n = 500) {
  for (let i = 0; i < n; i += 1) {
    if (await pred()) return;
    await tick();
  }
  throw new Error('condition not met');
}
const settle = async (n = 50) => {
  for (let i = 0; i < n; i += 1) await tick();
};

/** A counter entity whose `increment` blocks on a gate, so the caller can be replayed mid-call. */
function gatedCounter(store: InMemoryStateStore) {
  const engine = new WorkflowEngine({ store });
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let applied = 0;
  engine.registerEntity<{ count: number }>('counter', {
    initialState: () => ({ count: 0 }),
    handlers: {
      increment: async (s, by) => {
        await gate;
        applied += 1;
        s.count += by as number;
        return s.count;
      },
      add: (s, by) => {
        applied += 1;
        s.count += by as number;
        return s.count;
      },
    },
  });
  return { engine, open: () => open(), applied: () => applied };
}

describe('entities — exactly-once from the caller across replay', () => {
  it('ctx.callEntity: a replay before the reply does not re-send the operation', async () => {
    const store = new InMemoryStateStore();
    const { engine, open, applied } = gatedCounter(store);
    engine.register('caller', '1', async (ctx) =>
      ctx.callEntity<number>('counter', 'k', 'increment', 1),
    );

    await engine.start('caller', {}, 'c1');
    await until(async () => (await store.getRun('c1'))?.status === 'suspended');

    // Replay the caller while the entity is still working on the op (recovery, a reconcile wake, a
    // sibling branch's wake — anything that re-drives the run before the reply lands).
    await engine.resume('c1');
    await engine.resume('c1');
    await settle();

    open();
    await until(async () => (await store.getRun('c1'))?.status === 'completed');
    await settle();
    expect((await store.getRun('c1'))?.output).toBe(1);
    expect(applied()).toBe(1);
    expect(await engine.getEntityState('counter', 'k')).toEqual({ count: 1 });
  });

  it('ctx.signalEntity: a turn that dies after dispatch but before its checkpoint does not double-apply', async () => {
    const store = new InMemoryStateStore();
    const { engine, applied } = gatedCounter(store);
    // Simulate a crash in the window between the dispatch and the caller's checkpoint: the first
    // write of the `entitysig:*` marker throws, so the turn fails and the run is driven again.
    let failed = false;
    const original = store.saveCheckpoint.bind(store);
    store.saveCheckpoint = async (cp: StepCheckpoint) => {
      if (!failed && cp.runId === 's1' && cp.name.startsWith('entitysig:')) {
        failed = true;
        throw new Error('simulated crash after dispatch');
      }
      return original(cp);
    };
    engine.register('sender', '1', async (ctx) => {
      await ctx.signalEntity('counter', 'k', 'add', 5);
      return 'sent';
    });

    await engine.start('sender', {}, 's1').catch(() => undefined);
    await settle();
    expect(failed).toBe(true);
    await engine.resume('s1').catch(() => undefined);
    await until(async () => (await store.getRun('s1'))?.status === 'completed');
    await settle(100);
    expect(applied()).toBe(1);
    expect(await engine.getEntityState('counter', 'k')).toEqual({ count: 5 });
  });

  it('ctx.callEntity: a turn that dies after sending but before recording it re-sends a copy the entity skips', async () => {
    const store = new InMemoryStateStore();
    const { engine, applied } = gatedCounter(store);
    let failed = false;
    const original = store.saveCheckpointIfPending.bind(store);
    store.saveCheckpointIfPending = async (cp: StepCheckpoint) => {
      if (!failed && cp.runId === 'c2') {
        failed = true;
        throw new Error('simulated crash after the op was buffered');
      }
      return original(cp);
    };
    engine.register('caller', '1', async (ctx) => ctx.callEntity<number>('counter', 'k', 'add', 4));

    await engine.start('caller', {}, 'c2').catch(() => undefined);
    await settle();
    expect(failed).toBe(true);
    await engine.resume('c2').catch(() => undefined);
    await until(async () => (await store.getRun('c2'))?.status === 'completed');
    await settle(100);
    expect((await store.getRun('c2'))?.output).toBe(4);
    expect(applied()).toBe(1);
    expect(await engine.getEntityState('counter', 'k')).toEqual({ count: 4 });
  });

  it('a busy entity that replies before the intent is flipped still resolves the caller', async () => {
    const store = new InMemoryStateStore();
    const { engine, open, applied } = gatedCounter(store);
    engine.register('busy', '1', async (ctx) => {
      await ctx.signalEntity('counter', 'k', 'increment', 1); // parks the entity on the gate
      return 'ok';
    });
    engine.register('caller', '1', async (ctx) =>
      ctx.callEntity<number>('counter', 'k', 'add', 10),
    );
    await engine.start('busy', {}, 'b1');
    await settle();
    await engine.start('caller', {}, 'c3');
    await settle();
    open();
    await until(async () => (await store.getRun('c3'))?.status === 'completed');
    expect((await store.getRun('c3'))?.output).toBe(11);
    expect(applied()).toBe(2);
  });
});

describe('entities — a lost wake-up never strands a buffered op', () => {
  function lostKickEngine(opts: { clock?: () => number } = {}) {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, ...opts });
    engine.registerEntity<{ count: number }>('counter', {
      initialState: () => ({ count: 0 }),
      handlers: {
        add: (s, by) => {
          s.count += by as number;
          return s.count;
        },
      },
    });
    // The process "dies" right after the caller checkpointed: the deferred wake never happens.
    const entities = (engine as unknown as { entities: { kick: () => Promise<void> } }).entities;
    const kick = vi.spyOn(entities, 'kick').mockResolvedValue(undefined);
    return { store, engine, kick };
  }

  it('first contact: the entity run exists (and consumes the op) without any wake-up', async () => {
    const { store, engine, kick } = lostKickEngine();
    engine.register('sender', '1', async (ctx) => {
      await ctx.signalEntity('counter', 'fresh', 'add', 3);
      return 'sent';
    });
    await engine.start('sender', {}, 'f1');
    await until(async () => (await store.getRun('f1'))?.status === 'completed');
    await until(async () => (await engine.getEntityState('counter', 'fresh')) !== undefined);
    expect(kick).toHaveBeenCalled();
    expect(await engine.getEntityState('counter', 'fresh')).toEqual({ count: 3 });
  });

  it('a parked entity is paired with its buffered op by the reconcile sweep', async () => {
    let now = 1_000;
    const { store, engine } = lostKickEngine({ clock: () => now });
    await engine.signalEntity('counter', 'k', 'add', 1); // engine-side send: entity now parked
    await until(async () => (await store.getRun('entity:counter:k'))?.status === 'suspended');
    expect(await engine.getEntityState('counter', 'k')).toEqual({ count: 1 });

    engine.register('sender', '1', async (ctx) => {
      await ctx.signalEntity('counter', 'k', 'add', 2);
      return 'sent';
    });
    await engine.start('sender', {}, 'p1');
    await until(async () => (await store.getRun('p1'))?.status === 'completed');
    await settle();
    expect(await engine.getEntityState('counter', 'k')).toEqual({ count: 1 }); // not woken yet

    now += 10 * 60_000; // past the default reconcileMs
    await engine.resumeDueTimers(now);
    await until(
      async () => (await engine.getEntityState<{ count: number }>('counter', 'k'))?.count === 3,
    );
  });
});
