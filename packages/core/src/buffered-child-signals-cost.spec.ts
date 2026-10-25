import { describe, expect, it } from 'vitest';
import { childCompletionNeedsBuffer } from './buffered-child-signals';
import { instantCheckpoint } from './checkpoints';
import { WorkflowEngine } from './engine';
import type { StateStore, StepCheckpoint, WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * What the buffered-signal sweep and the child-completion check cost in store calls. On a real
 * database a read by name (`LIKE`, or an exact name) over a wide fan's parent scans that parent's
 * checkpoints, since nothing indexes `(run_id, name)`; one such read per buffered row is what kept a
 * worker's first timer poll from finishing. Reads by `(run_id, seq)` hit the primary key.
 */
const NAME_READS = ['listCheckpoints', 'listCheckpointsByNamePrefix', 'getLatestCheckpointByName'];

function counting(inner: InMemoryStateStore, delayMs = 0) {
  const calls: string[] = [];
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return async (...args: unknown[]) => {
        calls.push(prop);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as StateStore;
  return {
    store,
    calls,
    reset: () => {
      calls.length = 0;
    },
    nameReads: () => calls.filter((c) => NAME_READS.includes(c)),
  };
}

function parentRun(id: string, status: WorkflowRun['status'] = 'suspended'): WorkflowRun {
  return { id, workflow: 'load', workflowVersion: '1', status, input: {} };
}

/** `n` settled children of the unbounded fan at seq 0 of `parent`, one checkpoint each. */
function settledChildren(parent: string, n: number, from = 0): StepCheckpoint[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return instantCheckpoint({
      runId: parent,
      seq: i,
      name: `signal:child:${parent}.all.0.${i}`,
      kind: 'signal',
      output: { ok: true, value: i },
      parallelGroup: 'all:0:n40000',
    });
  });
}

async function bufferChildren(store: InMemoryStateStore, ids: string[], value = (i: number) => i) {
  for (const id of ids) {
    const i = Number(id.slice(id.lastIndexOf('.') + 1));
    await store.bufferSignal(`child:${id}`, { ok: true, value: value(i) });
  }
}

async function bufferedCount(store: InMemoryStateStore): Promise<number> {
  return (await store.listBufferedSignals('child:', undefined, 1_000_000)).length;
}

describe('sweepBufferedSignals reads a page set-based, not per row', () => {
  it('[sweep-cost] 500 rows of one parent with 40k checkpoints: a few calls, no read by name', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.saveCheckpoints(settledChildren('p', 40_000));
    await bufferChildren(
      inner,
      Array.from({ length: 500 }, (_, i) => `p.all.0.${20_000 + i}`),
    );
    const { store, calls, reset, nameReads } = counting(inner);
    const engine = new WorkflowEngine({ store });
    reset();

    expect(await engine.sweepBufferedSignals()).toBe(500);

    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(await bufferedCount(inner)).toBe(0);
  });

  it('[sweep-cost] rows of a folded fan, unbounded and in waves, are decided from the folds', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.createRun(parentRun('q'));
    // `p`: one fold for the whole fan at its first seq.
    await inner.saveCheckpoint(
      instantCheckpoint({
        runId: 'p',
        seq: 0,
        name: 'fan:p.all.0.',
        kind: 'signal',
        output: { from: 0, values: Array.from({ length: 40_000 }, (_, i) => i) },
      }),
    );
    // `q`: a fan in waves of 1000 starting at seq 3, every wave folded at its first child's seq.
    for (let k = 0; k < 40; k++) {
      await inner.saveCheckpoint(
        instantCheckpoint({
          runId: 'q',
          seq: 3 + k * 1_000,
          name: `fan:q.all.3.w${k}.`,
          kind: 'signal',
          output: { from: k * 1_000, values: Array.from({ length: 1_000 }, (_, j) => j) },
        }),
      );
    }
    await bufferChildren(inner, [
      ...Array.from({ length: 250 }, (_, i) => `p.all.0.${30_000 + i}`),
      ...Array.from({ length: 249 }, (_, i) => {
        const k = 7 + Math.floor(i / 100);
        return `q.all.3.w${k}.${k * 1_000 + (i % 100)}`;
      }),
    ]);
    const { store, calls, reset, nameReads } = counting(inner);
    const engine = new WorkflowEngine({ store });
    reset();

    expect(await engine.sweepBufferedSignals()).toBe(499);

    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(7);
  });

  it('[sweep-cost] keeps the rows a live parent has not settled, and decides them as cheaply', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    await inner.saveCheckpoints(settledChildren('p', 20_000));
    // 250 settled (doomed), 250 the parent has no checkpoint for yet (kept), 10 settled differently.
    await bufferChildren(inner, [
      ...Array.from({ length: 250 }, (_, i) => `p.all.0.${10_000 + i}`),
      ...Array.from({ length: 250 }, (_, i) => `p.all.0.${30_000 + i}`),
    ]);
    await bufferChildren(
      inner,
      Array.from({ length: 10 }, (_, i) => `p.all.0.${i}`),
      () => -1,
    );
    const { store, calls, reset, nameReads } = counting(inner);
    const engine = new WorkflowEngine({ store });
    reset();

    expect(await engine.sweepBufferedSignals()).toBe(250);

    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(8); // two pages
    expect(await bufferedCount(inner)).toBe(260);
  });

  it('[sweep-budget] one call stops at its time budget and the next resumes where it stopped', async () => {
    const inner = new InMemoryStateStore();
    // 500 rows of 500 different live parents: the worst case, one checkpoint read per parent.
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      await inner.createRun(parentRun(`p${i}`));
      await inner.saveCheckpoints(settledChildren(`p${i}`, 1, 3));
      ids.push(`p${i}.all.0.3`);
    }
    await bufferChildren(inner, ids);
    const { store } = counting(inner, 2);
    const engine = new WorkflowEngine({ store });

    const started = Date.now();
    const first = await engine.sweepBufferedSignals();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(800);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(500);
    let total = first;
    for (let call = 0; call < 100 && total < 500; call++)
      total += await engine.sweepBufferedSignals();
    expect(total).toBe(500);
    expect(await bufferedCount(inner)).toBe(0);
  }, 20_000);
});

describe('childCompletionNeedsBuffer on the write path', () => {
  it('[write-cost] costs a fixed number of key reads per completion of a 10k fan', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('p'));
    // The first half settled; the second half not yet.
    await inner.saveCheckpoints(settledChildren('p', 5_000));
    const { store, calls, reset, nameReads } = counting(inner);
    reset();

    const needed: boolean[] = [];
    for (let i = 0; i < 10_000; i++) {
      needed.push(await childCompletionNeedsBuffer(store, `p.all.0.${i}`, { ok: true, value: i }));
    }

    expect(needed.slice(0, 5_000).every((n) => n === false)).toBe(true);
    expect(needed.slice(5_000).every((n) => n === true)).toBe(true);
    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(2 * 10_000);
  });

  it('[write-cost] a child of a fan in waves whose wave folded is settled without a read by name', async () => {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun('q'));
    for (let k = 0; k < 10; k++) {
      await inner.saveCheckpoint(
        instantCheckpoint({
          runId: 'q',
          seq: k * 1_000,
          name: `fan:q.all.0.w${k}.`,
          kind: 'signal',
          output: { from: k * 1_000, values: Array.from({ length: 1_000 }, (_, j) => j) },
        }),
      );
    }
    const { store, calls, reset, nameReads } = counting(inner);
    reset();

    expect(await childCompletionNeedsBuffer(store, 'q.all.0.w4.4321', { ok: true, value: 1 })).toBe(
      false,
    );
    expect(nameReads()).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe('childCompletionNeedsBuffer reads by name only when the child id names no seq', () => {
  async function parentWith(id: string, checkpoints: StepCheckpoint[]) {
    const inner = new InMemoryStateStore();
    await inner.createRun(parentRun(id));
    await inner.saveCheckpoints(checkpoints);
    const counted = counting(inner);
    counted.reset();
    return counted;
  }
  const cp = (runId: string, seq: number, name: string, output: unknown) =>
    instantCheckpoint({ runId, seq, name, kind: 'signal', output });

  it('a ctx.startChild child, settled at a later seq than its spawn', async () => {
    const { store, nameReads } = await parentWith('s', [
      cp('s', 0, 'spawn:s.child.0', 's.child.0'),
      cp('s', 4, 'signal:child:s.child.0', { ok: true, value: 'x' }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 's.child.0', { ok: true, value: 'x' })).toBe(
      false,
    );
    expect(await childCompletionNeedsBuffer(store, 's.child.0', { ok: true, value: 'y' })).toBe(
      true,
    );
    expect(nameReads()).toHaveLength(2);
  });

  it('a ctx.child child with nothing at its seq is not settled, without a read by name', async () => {
    const { store, nameReads } = await parentWith('c', [
      cp('c', 0, 'signal:child:c.child.0', { ok: true, value: 1 }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 'c.child.3', { ok: true, value: 1 })).toBe(true);
    expect(await childCompletionNeedsBuffer(store, 'c.child.0', { ok: true, value: 1 })).toBe(
      false,
    );
    expect(nameReads()).toEqual([]);
  });

  it('a fan child past what the fold covers is not settled', async () => {
    const { store, nameReads } = await parentWith('f', [
      cp('f', 0, 'fan:f.all.0.', { from: 0, values: Array.from({ length: 100 }, (_, i) => i) }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 'f.all.0.150', { ok: true, value: 1 })).toBe(
      true,
    );
    expect(await childCompletionNeedsBuffer(store, 'f.all.0.99', { ok: true, value: 1 })).toBe(
      false,
    );
    expect(nameReads()).toEqual([]);
  });

  it('a fan in waves whose wave 0 did not fold falls back to the read by name', async () => {
    const { store, nameReads } = await parentWith('w', [
      cp('w', 0, 'signal:child:w.all.0.w0.0', { ok: false, error: 'boom' }),
      cp('w', 20, 'fan:w.all.0.w2.', { from: 20, values: Array.from({ length: 10 }, (_, i) => i) }),
    ]);
    expect(await childCompletionNeedsBuffer(store, 'w.all.0.w2.25', { ok: true, value: 5 })).toBe(
      false,
    );
    expect(await childCompletionNeedsBuffer(store, 'w.all.0.w3.35', { ok: true, value: 5 })).toBe(
      true,
    );
    expect(nameReads()).toHaveLength(2);
  });

  it('an onError handler, whose id names no seq', async () => {
    const { store } = await parentWith('o', [
      cp('o', 7, 'signal:child:o.onError.1', { ok: true, value: 'handled' }),
    ]);
    expect(
      await childCompletionNeedsBuffer(store, 'o.onError.1', { ok: true, value: 'handled' }),
    ).toBe(false);
    expect(await childCompletionNeedsBuffer(store, 'o.onError.2', { ok: true, value: 'x' })).toBe(
      true,
    );
  });
});
