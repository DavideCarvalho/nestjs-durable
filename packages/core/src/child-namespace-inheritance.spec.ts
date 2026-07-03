import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('child run namespace inheritance', () => {
  it('a child inherits the PARENT run namespace, not the executing engine namespace', async () => {
    const store = new InMemoryStateStore();
    // Operator-style engine: its OWN namespace is undefined, so it drives/executes runs of EVERY
    // namespace (orphan recovery, resume). When it runs a tenant-stamped parent's `ctx.child`, the
    // child must stay in the parent's namespace — otherwise an operator that recovery-resumes a
    // `davi-local` pipeline stamps its `processing` child `default` and it leaks off the tenant's
    // worker pool.
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async () => 'child-ok');
    engine.register('parent', '1', async (ctx) => {
      await ctx.child('child', {});
      return 'parent-ok';
    });

    // Parent explicitly stamped in tenant namespace 'alpha', the way a tenant engine.start stamps it.
    await engine.start('parent', {}, 'p1', { namespace: 'alpha' });

    await poll(async () => (await store.getRun('p1.child.0'))?.status === 'completed');

    expect((await store.getRun('p1'))?.namespace).toBe('alpha'); // sanity: parent carries the tenant
    expect((await store.getRun('p1.child.0'))?.namespace).toBe('alpha'); // child inherits it
  });

  it('a top-level run (no parent) still takes the engine namespace', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, namespace: 'beta' });
    engine.register('w', '1', async () => 'ok');

    await engine.start('w', {}, 'top-1');
    await poll(async () => (await store.getRun('top-1'))?.status === 'completed');

    expect((await store.getRun('top-1'))?.namespace).toBe('beta');
  });
});
