import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { inspect } from './inspect';

async function storeWithRuns() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('checkout', '1', async (ctx) => {
    await ctx.step('reserveStock', async () => 1);
    await ctx.step('ship', async () => 2);
    return 'ok';
  });
  await engine.start('checkout', {}, 'run1');
  return store;
}

describe('inspect', () => {
  it('lists runs as a table', async () => {
    const out = await inspect(await storeWithRuns(), {});
    expect(out).toContain('WORKFLOW');
    expect(out).toContain('checkout');
    expect(out).toContain('run1');
    expect(out).toContain('completed');
  });

  it('shows a run timeline when given a runId', async () => {
    const out = await inspect(await storeWithRuns(), { runId: 'run1' });
    expect(out).toContain('checkout');
    expect(out).toContain('reserveStock');
    expect(out).toContain('ship');
    expect(out).toContain('local');
  });

  it('reports a missing run', async () => {
    const out = await inspect(new InMemoryStateStore(), { runId: 'nope' });
    expect(out).toMatch(/not found/i);
  });

  it('says when there are no runs', async () => {
    const out = await inspect(new InMemoryStateStore(), {});
    expect(out).toMatch(/no runs/i);
  });

  it('filters by status', async () => {
    const out = await inspect(await storeWithRuns(), { status: 'failed' });
    expect(out).not.toContain('run1');
  });
});
