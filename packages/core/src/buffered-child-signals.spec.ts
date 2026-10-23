import { describe, expect, it } from 'vitest';
import { canonicalJson } from './buffered-child-signals';
import { WorkflowEngine } from './engine';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/** A child completion delivered again, the way a late or duplicate notification arrives. */
function renotify(engine: WorkflowEngine, childId: string, completion: unknown): Promise<void> {
  return (
    engine as unknown as { deliverToParent(token: string, c: unknown): Promise<void> }
  ).deliverToParent(`child:${childId}`, completion);
}

async function bufferedChildTokens(store: InMemoryStateStore): Promise<string[]> {
  return (await store.listBufferedSignals('child:', undefined, 10_000)).map((row) => row.token);
}

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met');
}

describe('a child completion nobody will consume is not buffered', () => {
  it('a root run (no parent) buffers nothing when it completes or fails', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async () => ({ rows: 3 }));
    engine.register('broken', '1', async () => {
      throw new Error('boom');
    });

    expect((await startRun(engine, 'job', {}, 'root-1')).status).toBe('completed');
    expect((await startRun(engine, 'broken', {}, 'root-2')).status).toBe('failed');
    await engine.drain(2_000);

    expect(await bufferedChildTokens(store)).toEqual([]);
  });

  it('a late notification for a child of a settled (folded) fan buffers nothing', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('line', '1', async (_ctx, input) => ({ line: (input as { i: number }).i }));
    engine.register('load', '1', async (ctx) => {
      // 100+ children: the settled fan is folded into one `fan:` checkpoint.
      const lines = await ctx.all(
        'line',
        Array.from({ length: 120 }, (_, i) => ({ i })),
      );
      await ctx.waitForSignal('more');
      return lines;
    });

    await engine.start('load', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    const children = await store.listRuns({ workflow: 'line' });
    expect(children).toHaveLength(120);
    expect((await store.listCheckpoints('p')).some((cp) => cp.name.startsWith('fan:'))).toBe(true);

    for (const child of children) {
      await renotify(engine, child.id, { ok: true, value: child.output });
    }

    expect(await bufferedChildTokens(store)).toEqual([]);
  });

  it('a duplicate notification whose payload came back with its keys reordered buffers nothing', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('fetch', '1', async () => ({ zeta: 1, alpha: { y: 2, b: 3 } }));
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child('fetch', {});
      await ctx.waitForSignal('more');
      return out;
    });

    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    const [settled] = (await store.listCheckpoints('p')).filter((cp) =>
      cp.name.startsWith('signal:child:'),
    );
    expect(settled?.status).toBe('completed');
    // What a MySQL JSON column hands back: the same value, keys in another order.
    await store.saveCheckpoint({
      ...(settled as NonNullable<typeof settled>),
      output: { value: { alpha: { b: 3, y: 2 }, zeta: 1 }, ok: true },
    });

    await renotify(engine, 'p.child.0', { ok: true, value: { zeta: 1, alpha: { y: 2, b: 3 } } });

    expect(await bufferedChildTokens(store)).toEqual([]);
  });

  it('a child whose parent is gone, or completed, buffers nothing', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('noop', '1', async () => 'ok');
    expect((await startRun(engine, 'noop', {}, 'finished')).status).toBe('completed');

    await renotify(engine, 'pruned.child.0', { ok: true, value: 1 });
    await renotify(engine, 'finished.child.3', { ok: true, value: 1 });

    expect(await bufferedChildTokens(store)).toEqual([]);
  });
});

describe('a child completion a parent can still consume stays buffered', () => {
  it('a fire-and-forget child of a live parent', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('quick', '1', async () => 'done');
    engine.register('parent', '1', async (ctx) => {
      await ctx.startChild('quick', {});
      return ctx.waitForSignal('more');
    });

    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p.child.0'))?.status === 'completed');
    await until(async () => (await bufferedChildTokens(store)).length > 0);

    expect(await bufferedChildTokens(store)).toEqual(['child:p.child.0']);
  });

  it('a success for a child a failed (retryable) parent holds as failed', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('flaky', '1', async () => {
      throw new Error('nope');
    });
    engine.register('parent', '1', async (ctx) => ctx.child('flaky', {}));

    await engine.start('parent', {}, 'p');
    await until(async () => (await store.getRun('p'))?.status === 'failed');
    await engine.drain(2_000);
    const store2Engine = new WorkflowEngine({ store });

    await renotify(store2Engine, 'p.child.0', { ok: true, value: 'fixed' });

    expect(await bufferedChildTokens(store)).toEqual(['child:p.child.0']);
  });
});

describe('sweepBufferedSignals', () => {
  it('deletes the buffered completions no parent will consume and keeps the rest', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('noop', '1', async () => 'ok');
    engine.register('waiting', '1', async (ctx) => ctx.waitForSignal('more'));
    expect((await startRun(engine, 'noop', {}, 'done-parent')).status).toBe('completed');
    await engine.start('waiting', {}, 'live-parent');
    await until(async () => (await store.getRun('live-parent'))?.status === 'suspended');

    // Rows an earlier version left behind, plus ones that are not child completions at all.
    await store.bufferSignal('child:01a169de-root', { ok: true, value: 1 });
    await store.bufferSignal('child:pruned.all.0.7', { ok: true, value: 1 });
    await store.bufferSignal('child:done-parent.child.0', { ok: false, error: 'x' });
    await store.bufferSignal('child:live-parent.child.0', { ok: true, value: 1 });
    await store.bufferSignal('order:42', { paid: true });

    expect(await engine.sweepBufferedSignals()).toBe(3);

    expect(await bufferedChildTokens(store)).toEqual(['child:live-parent.child.0']);
    expect(await store.takeBufferedSignal('order:42')).toEqual({ payload: { paid: true } });
  });

  it('drains a large backlog over a few calls, then rests', async () => {
    const store = new InMemoryStateStore();
    const clock = { now: 1_000_000 };
    const engine = new WorkflowEngine({ store, clock: () => clock.now });
    for (let i = 0; i < 2_500; i++) await store.bufferSignal(`child:root-${i}`, { ok: true });

    expect(await engine.sweepBufferedSignals()).toBe(2_000);
    expect(await engine.sweepBufferedSignals()).toBe(500);
    expect(await bufferedChildTokens(store)).toEqual([]);

    await store.bufferSignal('child:root-late', { ok: true });
    expect(await engine.sweepBufferedSignals()).toBe(0); // resting after a full pass
    clock.now += 10 * 60_000;
    expect(await engine.sweepBufferedSignals()).toBe(1);
  });

  it('does nothing on a namespaced engine', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, namespace: 'tenant-a' });
    await store.bufferSignal('child:root', { ok: true });
    expect(await engine.sweepBufferedSignals()).toBe(0);
    expect(await bufferedChildTokens(store)).toEqual(['child:root']);
  });
});

describe('canonicalJson', () => {
  it('ignores key order at every depth, and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
