import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * `registerStartOnly`: an instance that emits work (an API pod) starts runs of a workflow whose body
 * only other instances register. The run is stored and never executed here; a registered instance on
 * the same store runs it.
 */
describe('registerStartOnly', () => {
  it('stores the run without running it here', async () => {
    const store = new InMemoryStateStore();
    const api = new WorkflowEngine({ store });
    api.registerStartOnly('job', '1', { tags: ['kind:job'], origin: '@acme/jobs' });

    expect(await api.start('job', { n: 1 }, 'r1')).toEqual({ runId: 'r1', status: 'pending' });
    // Give an in-process dispatch every chance to (wrongly) pick it up.
    await new Promise((r) => setTimeout(r, 20));

    const run = await store.getRun('r1');
    expect(run).toMatchObject({
      status: 'pending',
      workflow: 'job',
      workflowVersion: '1',
      origin: '@acme/jobs',
      input: { n: 1 },
    });
    expect(run?.tags).toContain('kind:job');
  });

  it('is idempotent by run id', async () => {
    const store = new InMemoryStateStore();
    const api = new WorkflowEngine({ store });
    api.registerStartOnly('job', '1');
    await api.start('job', {}, 'r1');
    expect(await api.start('job', {}, 'r1')).toEqual({ runId: 'r1', status: 'pending' });
    expect((await store.listRuns({})).length).toBe(1);
  });

  it('a registered instance on the same store runs it; the start-only one leaves it quietly', async () => {
    const store = new InMemoryStateStore();
    const api = new WorkflowEngine({ store, instanceId: 'api' });
    const worker = new WorkflowEngine({ store, instanceId: 'worker' });
    api.registerStartOnly('job', '1');
    const ran: string[] = [];
    worker.register('job', '1', async (_ctx, input) => {
      ran.push((input as { who: string }).who);
      return 'done';
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await api.start('job', { who: 'x' }, 'r1');
      // The api polls first: it must hand the run back, not fail it and not log.
      await api.runPending();
      expect((await store.getRun('r1'))?.status).toBe('pending');
      expect(errors).not.toHaveBeenCalled();

      await worker.runPending();
      await worker.waitForRun('r1');
      expect(ran).toEqual(['x']);
      expect((await store.getRun('r1'))?.status).toBe('completed');
    } finally {
      errors.mockRestore();
    }
  });

  it('a pinned start resolves a start-only version and refuses another', async () => {
    const api = new WorkflowEngine({ store: new InMemoryStateStore() });
    api.registerStartOnly('job', '2');
    await expect(api.start('job', {}, 'a', { version: '2' })).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(api.start('job', {}, 'b', { version: '1' })).rejects.toThrow(/not registered/);
  });

  it('validates the input before creating the run', async () => {
    const store = new InMemoryStateStore();
    const api = new WorkflowEngine({ store });
    api.registerStartOnly('job', '1', {
      validateInput: () => {
        throw new Error('bad input');
      },
    });
    await expect(api.start('job', {}, 'r1')).rejects.toThrow('bad input');
    expect(await store.getRun('r1')).toBeNull();
  });

  it('a body registered on the same instance wins', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.registerStartOnly('job', '1');
    engine.register('job', '1', async () => 'here');
    await engine.start('job', {}, 'r1');
    expect(await engine.waitForRun('r1')).toMatchObject({ status: 'completed', output: 'here' });
  });
});
