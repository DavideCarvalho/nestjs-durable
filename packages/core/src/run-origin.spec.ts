import { describe, expect, it } from 'vitest';
import { type StartOptions, WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('run origin (which package declared the workflow)', () => {
  it('stamps the registration origin onto every run it starts', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('catalog', '1', async () => 'done', {
      origin: '@dudousxd/nestjs-catalog-pipeline',
    });

    await engine.start('catalog', {}, 'r1');

    expect((await store.getRun('r1'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
  });

  it('leaves the run unattributed when the registration carries no origin', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('mystery', '1', async () => 'done');

    await engine.start('mystery', {}, 'r1');

    // Unknown, NOT a stand-in like 'app' — the field is absent rather than wrong.
    expect((await store.getRun('r1'))?.origin).toBeUndefined();
  });

  it('ignores an origin smuggled in through the start options', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('catalog', '1', async () => 'done', {
      origin: '@dudousxd/nestjs-catalog-pipeline',
    });
    // `StartOptions` has no `origin`, so this can only be smuggled in at runtime — the run must still
    // carry the origin of the code that was registered.
    const opts: StartOptions = { tags: ['nightly'] };
    Object.assign(opts, { origin: '@evil/impostor' });

    await engine.start('catalog', {}, 'r1', opts);

    const run = await store.getRun('r1');
    expect(run?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
    expect(run?.tags).toEqual(['nightly']);
  });

  it('does not invent an origin for a workflow with no in-process registration', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.registerRemote('python-etl', '1', {
      group: 'python-etl',
      executor: { advance: async () => ({ runId: 'r1', commands: [], complete: false }) },
    });

    await engine.start('python-etl', {}, 'r1');

    expect((await store.getRun('r1'))?.origin).toBeUndefined();
  });

  it('filters listRuns by origin, and an unattributed run matches no origin', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('catalog', '1', async () => 1, { origin: '@dudousxd/nestjs-catalog-pipeline' });
    engine.register('agent', '1', async () => 2, { origin: '@dudousxd/nestjs-agent' });
    engine.register('inhouse', '1', async () => 3);
    await engine.start('catalog', {}, 'r-catalog');
    await engine.start('agent', {}, 'r-agent');
    await engine.start('inhouse', {}, 'r-inhouse');

    expect(
      (await store.listRuns({ origin: '@dudousxd/nestjs-catalog-pipeline' })).map((r) => r.id),
    ).toEqual(['r-catalog']);
    expect((await store.listRuns({ origin: '@dudousxd/nestjs-agent' })).map((r) => r.id)).toEqual([
      'r-agent',
    ]);
    // The unattributed run is only ever reachable through an unfiltered listing — which is exactly why
    // an origin facet has to keep an "all" option.
    expect(await store.listRuns({ origin: 'inhouse' })).toHaveLength(0);
    expect((await store.listRuns({})).map((r) => r.id)).toContain('r-inhouse');
  });

  it('ANDs origin with the other predicates', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('catalog', '1', async () => 1, { origin: '@dudousxd/nestjs-catalog-pipeline' });
    engine.register('agent', '1', async () => 2, { origin: '@dudousxd/nestjs-agent' });
    await engine.start('catalog', {}, 'r-catalog');
    await engine.start('agent', {}, 'r-agent');

    expect(
      await store.listRuns({ origin: '@dudousxd/nestjs-agent', workflow: 'catalog' }),
    ).toHaveLength(0);
  });
});
