import { expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { SINGLETON_ADMITTED_TAG } from './singleton-admission';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

it('fresh runs cannot inherit or supply a singleton admission marker', async () => {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const entered: string[] = [];
  engine.register(
    'job',
    '1',
    async (ctx) => {
      await ctx.localStep('enter', async () => void entered.push(ctx.runId));
      await ctx.waitForSignal(`release:${ctx.runId}`);
    },
    { singleton: { key: () => 'k' } },
  );
  try {
    await startRun(engine, 'job', {}, 'holder');
    await startRun(engine, 'job', {}, 'forged', { tags: [SINGLETON_ADMITTED_TAG, 'user-tag'] });
    const retry = await engine.retryWithInput('holder', {});
    if (!retry) throw new Error('holder disappeared');
    await engine.waitForRun(retry.runId);
    expect(entered).toEqual(['holder']);
    expect((await store.getRun('forged'))?.tags).toContain('user-tag');
    expect((await store.getRun('forged'))?.tags).not.toContain(SINGLETON_ADMITTED_TAG);
    expect((await store.getRun(retry.runId))?.tags).not.toContain(SINGLETON_ADMITTED_TAG);
  } finally {
    await engine.drain();
  }
});
