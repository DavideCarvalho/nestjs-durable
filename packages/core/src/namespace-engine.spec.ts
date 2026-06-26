import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('engine namespace partitioning', () => {
  it('stamps created runs with the engine namespace', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} }, // no-op: leave it pending so we can inspect the row
      namespace: 'alpha',
    });
    engine.register('w', '1', async () => 'ok');

    const { runId } = await engine.start('w', {}, 'run-stamp-1');
    expect(runId).toBe('run-stamp-1');
    expect((await store.getRun('run-stamp-1'))?.namespace).toBe('alpha');
  });

  it('defaults to "default" when no namespace is configured', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('w', '1', async () => 'ok');

    const { runId } = await engine.start('w', {}, 'run-default-1');
    expect(runId).toBe('run-default-1');
    expect((await store.getRun('run-default-1'))?.namespace).toBe('default');
  });

  it('a worker only picks up pending runs in its own namespace', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'mine',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'alpha',
      createdAt: now,
      updatedAt: now,
    });
    await store.createRun({
      id: 'theirs',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'beta',
      createdAt: now,
      updatedAt: now,
    });

    const ran: string[] = [];
    const engine = new WorkflowEngine({ store, namespace: 'alpha' });
    engine.register('w', '1', async (ctx) => {
      ran.push(ctx.runId);
      return 'ok';
    });

    await engine.runPending();
    await new Promise((r) => setTimeout(r, 20)); // let the dispatched run settle

    expect(ran).toEqual(['mine']);
    expect((await store.getRun('theirs'))?.status).toBe('pending'); // untouched by the alpha worker
  });

  it('runOne skips a run whose namespace differs from the engine', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'foreign',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'beta',
      createdAt: now,
      updatedAt: now,
    });
    const ran: string[] = [];
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      namespace: 'alpha',
    });
    engine.register('w', '1', async (ctx) => {
      ran.push(ctx.runId);
      return 'ok';
    });

    const result = await engine.runOne('foreign');

    expect(result).toBeNull();
    expect(ran).toEqual([]);
    expect((await store.getRun('foreign'))?.status).toBe('pending'); // not executed; lock released
  });

  it('runOne RUNS a run with an undefined namespace (back-compat for un-migrated stores)', async () => {
    // Wrap InMemoryStateStore to simulate a pre-namespace store row (namespace field absent).
    // InMemoryStateStore.createRun normalises undefined → 'default', so we subclass getRun
    // to strip the namespace for the 'legacy' run id only.
    class LegacyStore extends InMemoryStateStore {
      override async getRun(runId: string): Promise<WorkflowRun | null> {
        const run = await super.getRun(runId);
        if (run?.id === 'legacy') return { ...run, namespace: undefined };
        return run;
      }
    }

    const store = new LegacyStore();
    const now = new Date();
    await store.createRun({
      id: 'legacy',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: undefined,
      createdAt: now,
      updatedAt: now,
    });

    const ran: string[] = [];
    const engine = new WorkflowEngine({ store, namespace: 'alpha' });
    engine.register('w', '1', async (ctx) => {
      ran.push(ctx.runId);
      return 'ok';
    });

    await engine.runOne('legacy');
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toEqual(['legacy']); // undefined namespace is NOT skipped
  });
});
