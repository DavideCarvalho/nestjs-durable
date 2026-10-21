import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { RemoteTask, StepResult, Transport } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * Two results of one run handled at once on an instance must not run two turns of it at once. A
 * result resumes its run inline, and `execute` lets an instance into a lease it already holds, so a
 * results consumer with concurrency > 1 would otherwise overlap the run's turns.
 */

class CapturingTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

async function until(check: () => boolean | Promise<boolean>, max = 500): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

describe('step results of one run on one instance', () => {
  it('resume the run one at a time, so it never has two concurrent turns', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapturingTransport();
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    let active = 0;
    let maxActive = 0;
    engine.register('pair', '1', async (ctx) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return await Promise.all([ctx.step<number>('ext.a', {}), ctx.step<number>('ext.b', {})]);
      } finally {
        active -= 1;
      }
    });

    await engine.start('pair', {}, 'r1');
    await until(() => transport.dispatched.length === 2);
    await until(async () => (await store.getRun('r1'))?.status === 'suspended');
    maxActive = 0;

    const deliver = (task: RemoteTask) =>
      transport.result?.({
        runId: task.runId,
        seq: task.seq,
        stepId: task.stepId,
        status: 'completed',
        output: task.seq,
      });
    const [a, b] = transport.dispatched as [RemoteTask, RemoteTask];
    // The second result lands while the first one's turn holds the lease, mid-body.
    const first = deliver(a);
    await until(() => active === 1);
    const second = deliver(b);
    await Promise.all([first, second]);
    await until(async () => (await store.getRun('r1'))?.status === 'completed');

    expect((await store.getRun('r1'))?.output).toEqual([0, 1]);
    expect(maxActive).toBe(1);
  });
});
