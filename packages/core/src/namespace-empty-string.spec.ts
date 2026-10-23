import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * `''` is the default pool, not a namespace of its own: the transport already maps `''` to the bare
 * token like `'default'` (see tenantGroup), so a run stamped `''` must be one a default-pool engine
 * drives, polls and recovers. An UNSET namespace still means "operator" (drives every namespace).
 */
describe("an empty-string namespace is the 'default' pool", () => {
  it("an engine configured with namespace: '' stamps and polls 'default'", async () => {
    const store = new InMemoryStateStore();
    const quiet = new WorkflowEngine({
      store,
      namespace: '',
      runDispatcher: { dispatch: () => {} },
    });
    quiet.register('w', '1', async () => 'ok');
    await quiet.start('w', {}, 'r1');
    expect((await store.getRun('r1'))?.namespace).toBe('default');

    const worker = new WorkflowEngine({ store, namespace: 'default' });
    worker.register('w', '1', async () => 'ok');
    await worker.runPending();
    await worker.drain();
    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it("a run started with { namespace: '' } is driven by a default-pool engine", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, namespace: 'default' });
    engine.register('w', '1', async () => 'ok');
    await engine.start('w', {}, 'r2', { namespace: '' });
    await engine.waitForRun('r2', { timeoutMs: 2_000 });
    const run = await store.getRun('r2');
    expect(run?.namespace).toBe('default');
    expect(run?.status).toBe('completed');
  });

  it("a legacy row stamped '' is not refused by a default-pool engine's resume guard", async () => {
    const store = new InMemoryStateStore();
    const now = new Date();
    await store.createRun({
      id: 'legacy',
      workflow: 'w',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: '',
      createdAt: now,
      updatedAt: now,
    });
    const engine = new WorkflowEngine({ store, namespace: 'default' });
    engine.register('w', '1', async () => 'ok');
    await engine.runOne('legacy');
    await engine.drain();
    expect((await store.getRun('legacy'))?.status).toBe('completed');
  });
});
