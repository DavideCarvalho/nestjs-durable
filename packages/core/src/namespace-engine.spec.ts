import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
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

    const { runId } = await engine.start('w', {});
    expect((await store.getRun(runId))?.namespace).toBe('alpha');
  });

  it('defaults to "default" when no namespace is configured', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('w', '1', async () => 'ok');

    const { runId } = await engine.start('w', {});
    expect((await store.getRun(runId))?.namespace).toBe('default');
  });

  it('a worker only picks up pending runs in its own namespace', async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'mine', workflow: 'w', workflowVersion: '1', status: 'pending',
      input: {}, namespace: 'alpha', createdAt: now, updatedAt: now,
    });
    await store.createRun({
      id: 'theirs', workflow: 'w', workflowVersion: '1', status: 'pending',
      input: {}, namespace: 'beta', createdAt: now, updatedAt: now,
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
});
