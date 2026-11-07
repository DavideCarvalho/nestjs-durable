import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { ParentClosePolicy, RunStatus } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/** `ctx.startChild(ref, input, { parentClose })`: what happens to a live child when its parent ends. */

async function until(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const undone: string[] = [];
  // A child that does a compensable step, then waits for a signal that never comes.
  engine.register('child', '1', async (ctx) => {
    await ctx.localStep('reserve', async () => 'reserved', {
      compensate: async () => {
        undone.push(ctx.runId);
      },
    });
    await ctx.waitForSignal(`never:${ctx.runId}`);
  });
  // A parent that starts a child with the policy in its input, then finishes or fails.
  engine.register('parent', '1', async (ctx, input) => {
    const { policy, fail } = input as { policy?: ParentClosePolicy; fail?: boolean };
    await ctx.startChild(
      'child',
      {},
      { childId: `${ctx.runId}.kid`, ...(policy ? { parentClose: policy } : {}) },
    );
    // Let the child run to its wait before the parent ends.
    await ctx.localStep('wait-for-child-to-park', () => new Promise((r) => setTimeout(r, 50)));
    if (fail) {
      await ctx.localStep('break', async () => {
        throw new Error('parent broke');
      });
    }
    return 'parent done';
  });
  const status = async (id: string): Promise<RunStatus | undefined> =>
    (await store.getRun(id))?.status;
  return { store, engine, undone, status };
}

describe('parentClose', () => {
  it("'cancel': a completed parent cancels its child with the saga undo", async () => {
    const { engine, undone, status } = setup();
    await engine.start('parent', { policy: 'cancel' }, 'p1');
    expect((await engine.waitForRun('p1')).status).toBe('completed');
    await until(async () => (await status('p1.kid')) === 'cancelled');
    await until(async () => undone.includes('p1.kid'));
  });

  it("'terminate': a failed parent cancels its child without compensating", async () => {
    const { engine, undone, status, store } = setup();
    await engine.start('parent', { policy: 'terminate', fail: true }, 'p2');
    expect(['failed', 'dead']).toContain((await engine.waitForRun('p2')).status);
    await until(async () => (await status('p2.kid')) === 'cancelled');
    expect(undone).not.toContain('p2.kid');
    expect((await store.getRun('p2.kid'))?.tags).toContain('parent-close:terminate');
  });

  it("'abandon': the child outlives a completed parent", async () => {
    const { engine, status } = setup();
    await engine.start('parent', { policy: 'abandon' }, 'p3');
    expect((await engine.waitForRun('p3')).status).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await status('p3.kid')).toBe('suspended');
  });

  it("'abandon': the child outlives a CANCELLED parent too (the cascade skips it)", async () => {
    const { engine, status } = setup();
    engine.register('holder', '1', async (ctx) => {
      await ctx.startChild('child', {}, { childId: 'h.kid', parentClose: 'abandon' });
      await ctx.startChild('child', {}, { childId: 'h.kid2' });
      await ctx.waitForSignal('never:holder');
    });
    await engine.start('holder', {}, 'h');
    await engine.waitForRun('h');
    await until(
      async () =>
        (await status('h.kid')) === 'suspended' && (await status('h.kid2')) === 'suspended',
    );
    await engine.cancel('h');
    await until(async () => (await status('h.kid2')) === 'cancelled');
    expect(await status('h.kid')).toBe('suspended');
  });

  it('no policy: a completed parent leaves its child running, as before', async () => {
    const { engine, status } = setup();
    await engine.start('parent', {}, 'p4');
    expect((await engine.waitForRun('p4')).status).toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await status('p4.kid')).toBe('suspended');
  });
});
