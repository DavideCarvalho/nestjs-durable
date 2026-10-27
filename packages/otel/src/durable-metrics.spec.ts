import {
  FatalError,
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { attachDurableMetrics } from './durable-metrics';

/** Two engines sharing a store and a broadcast transport: a pod that runs the work and one that only hears it. */
function twoPods() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const worker = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'worker',
  });
  const other = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'other',
  });
  worker.register('wf', '1', async (ctx) => {
    await ctx.localStep('a', async () => 1);
    return 'ok';
  });
  return { worker, other };
}

describe('attachDurableMetrics', () => {
  it('counts runs/steps and records duration percentiles', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);

    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      await ctx.localStep('b', async () => 2);
      return 'done';
    });
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');

    const snap = metrics.snapshot();
    expect(snap.runs.started).toBe(1);
    expect(snap.runs.completed).toBe(1);
    expect(snap.steps.completed).toBe(2);
    expect(snap.stepDurationMs.count).toBe(2);
    expect(snap.runDurationMs.count).toBe(1);

    metrics.reset();
    expect(metrics.snapshot().runs.started).toBe(0);
    metrics.unsubscribe();
  });

  it('counts a failed run', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);
    engine.register('boom', '1', async (ctx) =>
      ctx.localStep('x', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('boom', {}, 'run2');
    await engine.waitForRun('run2');
    const snap = metrics.snapshot();
    expect(snap.runs.failed).toBe(1);
    expect(snap.steps.failed).toBe(1);
  });

  it('counts a failure handed to an onError handler, by code', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = attachDurableMetrics(engine);
    engine.register('dlq', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async () => {
        throw new FatalError('bad line', 'invalid_line');
      },
      { onError: [{ code: 'invalid_line', workflow: 'dlq' }] },
    );
    await engine.start('line', {}, 'r');
    await engine.waitForRun('r', { until: 'terminal' });

    const snap = metrics.snapshot();
    expect(snap.runs.routed).toBe(1);
    expect(snap.runs.failed).toBe(0);
    expect(snap.routedByCode).toEqual({ invalid_line: 1 });
  });

  it('counts a run on the pod that ran it, not on every pod that heard it', async () => {
    const { worker, other } = twoPods();
    const onWorker = attachDurableMetrics(worker);
    const onOther = attachDurableMetrics(other);

    await worker.start('wf', {}, 'run1');
    await worker.waitForRun('run1');

    expect(onWorker.snapshot().runs.started).toBe(1);
    expect(onOther.snapshot().runs.started).toBe(0);
    expect(onOther.snapshot().steps.completed).toBe(0);
  });
});
