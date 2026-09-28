import { describe, expect, it } from 'vitest';
import { countRuns } from './concurrency';
import { WorkflowEngine } from './engine';
import { ConcurrencyLimitError } from './errors';
import type { StateStore } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

function setup(store: StateStore = new InMemoryStateStore()) {
  const engine = new WorkflowEngine({ store });
  return { engine, store };
}

describe('start-time concurrency quota', () => {
  it('derives the key and a per-key limit from the workflow config', async () => {
    const { engine } = setup();
    engine.register('turn', '1', async (ctx) => ctx.waitForSignal(`go:${ctx.runId}`), {
      concurrency: {
        key: (input) => `tenant:${(input as { tenant: string }).tenant}`,
        limit: async (key) => (key === 'tenant:big' ? 2 : 1),
      },
    });

    await engine.start('turn', { tenant: 'small' }, 's1');
    const err = await engine.start('turn', { tenant: 'small' }, 's2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrencyLimitError);
    expect(err).toMatchObject({ key: 'tenant:small', limit: 1, active: 1, workflow: 'turn' });

    await engine.start('turn', { tenant: 'big' }, 'b1');
    await engine.start('turn', { tenant: 'big' }, 'b2');
    await expect(engine.start('turn', { tenant: 'big' }, 'b3')).rejects.toThrow(
      ConcurrencyLimitError,
    );
  });

  it('shares one key across workflows, and a suspended run counts by default', async () => {
    const { engine } = setup();
    const concurrency = { key: () => 'tenant:a', limit: 1 };
    engine.register('a', '1', async (ctx) => ctx.waitForSignal('never'), { concurrency });
    engine.register('b', '1', async () => 'ok', { concurrency });

    await engine.start('a', {}, 'a1');
    expect((await engine.waitForRun('a1')).status).toBe('suspended');
    await expect(engine.start('b', {}, 'b1')).rejects.toThrow(/concurrency limit/);
  });

  it('countStatuses can leave runs parked on a human out of the count', async () => {
    const { engine } = setup();
    engine.register('a', '1', async (ctx) => ctx.waitForSignal('never'), {
      concurrency: { key: () => 'k', limit: 1, countStatuses: ['pending', 'running'] },
    });
    await engine.start('a', {}, 'a1');
    expect((await engine.waitForRun('a1')).status).toBe('suspended');
    await engine.start('a', {}, 'a2'); // a1 is suspended → not counted
    await expect(engine.start('a', {}, 'a3')).rejects.toThrow(/concurrency limit/); // a2 still pending
  });

  it('a key of undefined leaves the start unlimited; a per-start quota overrides the config', async () => {
    const { engine } = setup();
    engine.register('a', '1', async (ctx) => ctx.waitForSignal('never'), {
      concurrency: { key: (input) => (input as { k?: string }).k, limit: 1 },
    });
    await engine.start('a', {}, 'u1');
    await engine.start('a', {}, 'u2');
    await engine.start('a', { k: 'x' }, 'x1');
    await engine.start('a', { k: 'x' }, 'x2', { concurrency: { key: 'x', limit: 5 } });
    await expect(
      engine.start('a', { k: 'x' }, 'x3', { concurrency: { key: 'x', limit: 0 } }),
    ).rejects.toThrow(/0\/0/);
  });

  it('an idempotent re-start of an existing run is never rejected', async () => {
    const { engine } = setup();
    engine.register('a', '1', async (ctx) => ctx.waitForSignal('never'), {
      concurrency: { key: () => 'k', limit: 1 },
    });
    await engine.start('a', {}, 'same');
    await expect(engine.start('a', {}, 'same')).resolves.toMatchObject({ runId: 'same' });
  });

  it('stamps the quota tag on the run', async () => {
    const { engine, store } = setup();
    engine.register('a', '1', async () => 'ok');
    await engine.start('a', {}, 'r', { tags: ['mine'], concurrency: { key: 'k', limit: 3 } });
    expect((await store.getRun('r'))?.tags).toEqual(['mine', 'concurrency:k']);
  });
});

describe('countRuns fallback', () => {
  it('uses runFacets, then listRuns, when the store has no countRuns', async () => {
    const inner = new InMemoryStateStore();
    for (const [id, status] of [
      ['1', 'running'],
      ['2', 'pending'],
      ['3', 'completed'],
    ] as const) {
      await inner.createRun({
        id,
        workflow: 'w',
        workflowVersion: '1',
        status,
        input: null,
        tags: ['t'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const facetsOnly = Object.assign(Object.create(inner) as InMemoryStateStore, {
      countRuns: undefined,
    });
    expect(await countRuns(facetsOnly, { tag: 't', statuses: ['running', 'pending'] })).toBe(2);
    const listOnly = Object.assign(Object.create(inner) as InMemoryStateStore, {
      countRuns: undefined,
      runFacets: undefined,
    });
    expect(await countRuns(listOnly, { tag: 't', statuses: ['running', 'pending'] })).toBe(2);
  });
});
