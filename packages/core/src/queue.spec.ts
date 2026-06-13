import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowEngine } from './engine';
import type { RemoteTask, StepResult, Transport } from './interfaces';
import { remoteStep } from './remote-step-factory';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

const ping = remoteStep({
  name: 'ext.ping',
  group: 'ext',
  input: z.object({}),
  output: z.object({ pong: z.boolean() }),
});

/** Drive the InMemoryTransport's deferred results until `runId` reaches a terminal state. */
async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

/** A transport that holds dispatches so a test can control when (and whether) a step completes. */
class ManualTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  private result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
  async complete(task: RemoteTask): Promise<void> {
    await this.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { pong: true },
    });
  }
}

describe('flow control — durable queues', () => {
  it('rate-limits admissions per queue and resumes blocked calls when the window resets', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('ext.ping', async () => ({ pong: true }));
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.registerQueue({ name: 'api', rateLimit: { limit: 2, periodMs: 1000 } });
    engine.register('caller', '1', async (ctx) => {
      await ctx.call(ping, {}, { queue: 'api' });
      return 'done';
    });

    await engine.start('caller', {}, 'a');
    await engine.start('caller', {}, 'b');
    const c = await engine.start('caller', {}, 'c');

    // a and b are admitted within the window; c exceeds the limit → suspended, not dispatched.
    expect(c.status).toBe('suspended');
    await settle(store, 'a');
    await settle(store, 'b');
    expect((await store.getRun('c'))?.status).toBe('suspended');
    expect((await store.getRun('c'))?.output).toBeUndefined();

    // Advance past the window → the blocked call is admitted on resume.
    nowMs += 1000;
    await engine.resumeDueTimers(nowMs);
    expect((await settle(store, 'c')).status).toBe('completed');
  });

  it('limits concurrent in-flight steps per queue, admitting the next when a slot frees', async () => {
    const store = new InMemoryStateStore();
    const transport = new ManualTransport();
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.registerQueue({ name: 'db', concurrency: 1 });
    engine.register('caller', '1', async (ctx) => {
      await ctx.call(ping, {}, { queue: 'db' });
      return 'done';
    });

    await engine.start('caller', {}, 'a'); // admitted → in-flight (1/1)
    await engine.start('caller', {}, 'b'); // blocked (1 >= 1) → suspended
    expect(transport.dispatched).toHaveLength(1);
    expect((await store.getRun('b'))?.status).toBe('suspended');

    // Complete a → frees the slot.
    await transport.complete(transport.dispatched[0]!);
    await new Promise((r) => setImmediate(r));
    expect((await store.getRun('a'))?.status).toBe('completed');

    // Resume b (its retry timer is due) → now admitted and dispatched.
    nowMs += 1000;
    await engine.resumeDueTimers(nowMs);
    expect(transport.dispatched).toHaveLength(2);
    await transport.complete(transport.dispatched[1]!);
    await new Promise((r) => setImmediate(r));
    expect((await store.getRun('b'))?.status).toBe('completed');
  });
});
