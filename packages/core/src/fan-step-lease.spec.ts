import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { Heartbeat, RemoteTask, StateStore, StepResult, Transport } from './interfaces';
import { DURABLE_STEP_NAME, type StepRef } from './step-name-symbol';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * With the lost-dispatch self-heal on, a step fan's steps are written with their lease already
 * stamped: the fan's next turn has no lease to stamp step by step, the run parks on the lease, and a
 * beat from a step's worker finds nothing to renew without reading the step.
 */

const STEP = 'Lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = STEP;

class CapturingTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result: ((r: StepResult) => Promise<void>) | undefined;
  beat: ((b: Heartbeat) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    this.dispatched.push(...tasks);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(handler: (b: Heartbeat) => Promise<void>): void {
    this.beat = handler;
  }
}

function counting(inner: StateStore) {
  const calls = new Map<string, number>();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        calls.set(prop, (calls.get(prop) ?? 0) + 1);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as StateStore;
  return { store, count: (name: string) => calls.get(name) ?? 0, reset: () => calls.clear() };
}

async function until(check: () => boolean | Promise<boolean>, budgetMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > budgetMs) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('a step fan under the lost-dispatch self-heal', () => {
  it('is sent with every step’s lease stamped, and its pickup beats read nothing', async () => {
    const inner = new InMemoryStateStore();
    const counted = counting(inner);
    const transport = new CapturingTransport();
    const engine = new WorkflowEngine({
      store: counted.store,
      transport,
      reconcileMs: 0,
      remoteRedispatchMs: 60_000,
    });
    engine.register('fan', '1', async (ctx) =>
      ctx.all(
        processLine,
        Array.from({ length: 200 }, (_, i) => ({ i })),
      ),
    );
    const before = Date.now();
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 200);
    await until(async () => (await inner.getRun('p'))?.status === 'suspended');

    const checkpoints = await inner.listCheckpoints('p');
    expect(checkpoints).toHaveLength(200);
    for (const cp of checkpoints) expect(cp.wakeAt).toBeGreaterThanOrEqual(before + 60_000);
    // Parked on the lease, so a fan whose dispatch is lost is re-driven.
    expect((await inner.getRun('p'))?.wakeAt).toBeDefined();

    counted.reset();
    await Promise.all(
      transport.dispatched.map((task) =>
        transport.beat?.({
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          group: task.group,
        } as Heartbeat),
      ),
    );
    expect(counted.count('getCheckpoint')).toBe(0);
    expect(counted.count('saveCheckpoint')).toBe(0);

    await Promise.all(
      transport.dispatched.map((task) =>
        transport.result?.({
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'completed',
          output: (task.input as { i: number }).i,
        }),
      ),
    );
    const run = await engine.waitForRun('p', { terminal: true });
    expect(run.status).toBe('completed');
  });
});
