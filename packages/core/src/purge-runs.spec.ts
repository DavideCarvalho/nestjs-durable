import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StateStore } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function setup(store: StateStore = new InMemoryStateStore()) {
  const engine = new WorkflowEngine({ store });
  engine.register('child', '1', async (ctx) => ctx.waitForSignal('never'));
  engine.register('done', '1', async () => 'ok');
  engine.register('parent', '1', async (ctx) => {
    await ctx.startChild('child', {}, `${ctx.runId}.c`);
    return 'spawned';
  });
  return { engine, store };
}

describe('engine.purgeRuns', () => {
  it('purges a tag scope with the untagged children of the matching runs', async () => {
    const { engine, store } = await setup();
    await engine.start('parent', {}, 'a1', { tags: ['tenant:a'] });
    await engine.start('done', {}, 'a2', { tags: ['tenant:a'] });
    await engine.start('done', {}, 'b1', { tags: ['tenant:b'] });
    for (const id of ['a1', 'a1.c', 'a2', 'b1']) await engine.waitForRun(id);

    // a1 (completed) spawned a1.c, which is still suspended (live) and carries no tag.
    expect(await engine.purgeRuns({ tag: 'tenant:a' })).toBe(3);

    expect(await store.getRun('a1')).toBeNull();
    expect(await store.getRun('a1.c')).toBeNull();
    expect(await store.getRun('a2')).toBeNull();
    expect(await store.getRun('b1')).not.toBeNull();
  });

  it('cancelLive:false keeps live runs, including live children of finished roots', async () => {
    const { engine, store } = await setup();
    await engine.start('parent', {}, 'p', { tags: ['t'] });
    await engine.start('child', {}, 'live', { tags: ['t'] });
    for (const id of ['p', 'p.c', 'live']) await engine.waitForRun(id);

    expect(await engine.purgeRuns({ tag: 't' }, { cancelLive: false })).toBe(1);

    expect(await store.getRun('p')).toBeNull();
    expect((await store.getRun('p.c'))?.status).toBe('suspended');
    expect((await store.getRun('live'))?.status).toBe('suspended');
  });

  it('children:false deletes exactly the matching runs', async () => {
    const { engine, store } = await setup();
    await engine.start('parent', {}, 'p', { tags: ['t'] });
    for (const id of ['p', 'p.c']) await engine.waitForRun(id);

    expect(await engine.purgeRuns({ tag: 't' }, { children: false })).toBe(1);
    expect(await store.getRun('p.c')).not.toBeNull();
  });

  it('purgeNamespace drains a namespace in batches and leaves the others', async () => {
    const { engine, store } = await setup();
    for (let i = 0; i < 7; i++) await engine.start('done', {}, `x${i}`, { namespace: 'gone' });
    await engine.start('done', {}, 'stay', { namespace: 'kept' });
    for (let i = 0; i < 7; i++) await engine.waitForRun(`x${i}`);

    expect(await engine.purgeNamespace('gone', { batchSize: 3 })).toBe(7);
    expect(await store.listRuns({ namespace: 'gone' })).toEqual([]);
    expect(await store.getRun('stay')).not.toBeNull();
  });

  it('falls back to per-run deleteRun on a store without deleteRuns', async () => {
    const inner = new InMemoryStateStore();
    const store = Object.assign(Object.create(inner) as InMemoryStateStore, {
      deleteRuns: undefined,
    });
    const { engine } = await setup(store);
    await engine.start('done', {}, 'r', { tags: ['t'] });
    await engine.waitForRun('r');

    expect(await engine.purgeRuns({ tag: 't' })).toBe(1);
    expect(await inner.getRun('r')).toBeNull();
  });

  it('refuses an empty scope', async () => {
    const { engine } = await setup();
    await expect(engine.purgeRuns({})).rejects.toThrow(/empty scope/);
    await expect(engine.purgeRuns({ attributes: [] })).rejects.toThrow(/empty scope/);
  });
});
