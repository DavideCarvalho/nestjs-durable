import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { GatherError } from './errors';
import type { RemoteTask, StateStore, StepCheckpoint, StepResult, Transport } from './interfaces';
import { DURABLE_STEP_NAME, type StepRef } from './step-name-symbol';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A run's step results are settled in batches: the results that arrive while one batch is being
 * written are written together by the next, and the fan's barrier is asked once per batch. These
 * specs pin what that must not change: each step settles once, the parent wakes once per settled
 * wave, failures still wake it, and a result is acknowledged only after its write committed.
 */

const LINE = 'Lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = LINE;

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

async function until(check: () => boolean | Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

/** Records dispatches; the test delivers the results, as a broker's results consumer would. */
class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  handler?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(): void {}
  /** Take every dispatched task not yet taken. */
  take(): RemoteTask[] {
    return this.dispatched.splice(0);
  }
  deliver(result: StepResult): Promise<void> {
    if (!this.handler) throw new Error('no result handler');
    return this.handler(result);
  }
}

const ok = (t: RemoteTask, output: unknown = (t.input as { i: number }).i * 10): StepResult => ({
  runId: t.runId,
  seq: t.seq,
  stepId: t.stepId,
  status: 'completed',
  output,
});

const failed = (t: RemoteTask): StepResult => ({
  runId: t.runId,
  seq: t.seq,
  stepId: t.stepId,
  status: 'failed',
  error: { message: `bad line ${(t.input as { i: number }).i}`, retryable: false },
});

/** Counts every store call by method. */
function counting<T extends StateStore>(inner: T): { store: T; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        return value.apply(target, args);
      };
    },
  });
  return { store, calls };
}

function setup(store: StateStore = new InMemoryStateStore()) {
  const transport = new HeldTransport();
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
  let turns = 0;
  const settled: number[] = [];
  engine.subscribe((e) => {
    if (e.type === 'step.completed' || e.type === 'step.failed') settled.push(e.seq);
  });
  const register = (body: Parameters<WorkflowEngine['register']>[2]) =>
    engine.register('fan', '1', async (ctx, input) => {
      turns += 1;
      return body(ctx, input);
    });
  return { store, transport, engine, register, settled, turns: () => turns };
}

describe('batched step results', () => {
  it('settles a fan whose results arrive together with one batched write and one barrier read', async () => {
    const { store, calls } = counting(new InMemoryStateStore());
    const { transport, engine, register, settled, turns } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(200)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 200);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    calls.clear();

    await Promise.all(transport.take().map((t) => transport.deliver(ok(t))));
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect((await store.getRun('p'))?.output).toEqual(lines(200).map(({ i }) => i * 10));
    expect(settled).toHaveLength(200);
    expect(calls.get('saveCheckpointsIfPending')).toBe(1);
    expect(calls.get('saveCheckpointIfPending') ?? 0).toBe(0);
    expect(calls.get('countCheckpoints')).toBe(1);
    // The dispatching turn, then exactly one more once the fan settled.
    expect(turns()).toBe(2);
  });

  it('a batch holding the last of a wave wakes the parent once, and the next wave is sent', async () => {
    const { transport, engine, register, store, turns } = setup();
    register(async (ctx) => ctx.all(processLine, lines(30), { concurrency: 10 }));
    await engine.start('fan', {}, 'p');
    for (let wave = 0; wave < 3; wave += 1) {
      await until(() => transport.dispatched.length === 10);
      const tasks = transport.take();
      // Two batches for the wave: the first leaves the barrier closed, the second opens it.
      await Promise.all(tasks.slice(0, 6).map((t) => transport.deliver(ok(t))));
      expect(transport.dispatched).toHaveLength(0);
      await Promise.all(tasks.slice(6).map((t) => transport.deliver(ok(t))));
    }
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(lines(30).map(({ i }) => i * 10));
    // One dispatching turn, then one turn per settled wave.
    expect(turns()).toBe(4);
  });

  it('drops a duplicate inside a batch and one delivered after it', async () => {
    const { transport, engine, register, store, settled } = setup();
    register(async (ctx) => ctx.all(processLine, lines(5)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 5);
    const tasks = transport.take();
    const first = tasks[0] as RemoteTask;
    await Promise.all([
      ...tasks.map((t) => transport.deliver(ok(t))),
      transport.deliver(ok(first, 'second copy')),
    ]);
    await transport.deliver(ok(first, 'late copy'));
    await until(async () => (await store.getRun('p'))?.status === 'completed');

    expect([...settled].sort((a, b) => a - b)).toEqual(tasks.map((t) => t.seq));
    expect((await store.getRun('p'))?.output).toEqual([0, 10, 20, 30, 40]);
  });

  it('settles a batch in arrival order', async () => {
    const { transport, engine, register, store, settled } = setup();
    register(async (ctx) => ctx.all(processLine, lines(50)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 50);
    const tasks = transport.take().reverse();
    await Promise.all(tasks.map((t) => transport.deliver(ok(t))));
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect(settled).toEqual(tasks.map((t) => t.seq));
  });

  it('several failures in one batch of a waitAll fan wake the parent once', async () => {
    const { transport, engine, register, store, turns } = setup();
    register(async (ctx) => {
      try {
        return await ctx.all(processLine, lines(6));
      } catch (err) {
        if (err instanceof GatherError) return { failed: err.failures.map((f) => f.index) };
        throw err;
      }
    });
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 6);
    const tasks = transport.take();
    await Promise.all(tasks.map((t, i) => transport.deliver(i % 2 ? failed(t) : ok(t))));
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual({ failed: [1, 3, 5] });
    expect(turns()).toBe(2);
  });

  it('failFast: a failure wakes the parent while the rest of the fan is still out', async () => {
    const { transport, engine, register, store } = setup();
    register(async (ctx) => {
      try {
        return await ctx.all(processLine, lines(8), { mode: 'failFast' });
      } catch (err) {
        if (err instanceof GatherError) return { failed: err.failures.map((f) => f.index) };
        throw err;
      }
    });
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 8);
    const tasks = transport.take();
    // One batch: two successes and the failure; five steps are still running.
    await Promise.all([
      transport.deliver(ok(tasks[0] as RemoteTask)),
      transport.deliver(failed(tasks[1] as RemoteTask)),
      transport.deliver(ok(tasks[2] as RemoteTask)),
    ]);
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual({ failed: [1] });
  });

  it('acknowledges a result only after the batch holding it committed', async () => {
    class GatedStore extends InMemoryStateStore {
      open?: () => void;
      gate = new Promise<void>((resolve) => {
        this.open = resolve;
      });
      async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
        await this.gate;
        return super.saveCheckpointsIfPending(checkpoints);
      }
    }
    const store = new GatedStore();
    const { transport, engine, register } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(20)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 20);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');

    const acked = new Set<number>();
    const deliveries = transport
      .take()
      .map((t) => transport.deliver(ok(t)).then(() => acked.add(t.seq)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acked.size).toBe(0);
    expect(await store.countCheckpoints('p', 0, 19, ['pending'])).toBe(20);

    store.open?.();
    await Promise.all(deliveries);
    expect(acked.size).toBe(20);
    expect(await store.countCheckpoints('p', 0, 19, ['pending'])).toBe(0);
  });

  it('a batch whose write fails rejects its results, and their redelivery completes the fan', async () => {
    // The batch write rejects once (a crash before commit writes nothing), and so does the
    // one-by-one retry of its rows, so every result of the batch goes back to the broker.
    class FailingStore extends InMemoryStateStore {
      failures = 1;
      async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
        if (this.failures > 0) throw new Error('connection lost');
        return super.saveCheckpointsIfPending(checkpoints);
      }
      async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
        if (this.failures > 0) throw new Error('connection lost');
        return super.saveCheckpointIfPending(checkpoint);
      }
    }
    const store = new FailingStore();
    const { transport, engine, register, settled } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(10)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 10);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    const tasks = transport.take();

    const outcomes = await Promise.allSettled(tasks.map((t) => transport.deliver(ok(t))));
    expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
    expect(await store.countCheckpoints('p', 0, 9, ['pending'])).toBe(10);
    expect(settled).toEqual([]);

    store.failures = 0;
    await Promise.all(tasks.map((t) => transport.deliver(ok(t))));
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual(lines(10).map(({ i }) => i * 10));
    expect(settled).toHaveLength(10);
  });

  it('one row the store rejects fails only its own result', async () => {
    class PoisonStore extends InMemoryStateStore {
      async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
        if (checkpoints.some((cp) => cp.output === 'poison')) throw new Error('value too long');
        return super.saveCheckpointsIfPending(checkpoints);
      }
      async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
        if (checkpoint.output === 'poison') throw new Error('value too long');
        return super.saveCheckpointIfPending(checkpoint);
      }
    }
    const store = new PoisonStore();
    const { transport, engine, register } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(6)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 6);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    const tasks = transport.take();

    const outcomes = await Promise.allSettled(
      tasks.map((t, i) => transport.deliver(ok(t, i === 2 ? 'poison' : undefined))),
    );
    expect(outcomes.map((o) => o.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(await store.countCheckpoints('p', 0, 5, ['pending'])).toBe(1);
    // The redelivered result settles the last step and opens the barrier.
    await transport.deliver(ok(tasks[2] as RemoteTask, 'fixed'));
    await until(async () => (await store.getRun('p'))?.status === 'completed');
  });

  it('a store without the batched write settles each result with its own compare-and-set', async () => {
    const inner = new InMemoryStateStore();
    Object.defineProperty(inner, 'saveCheckpointsIfPending', { value: undefined });
    const { store, calls } = counting(inner);
    const { transport, engine, register } = setup(store);
    register(async (ctx) => ctx.all(processLine, lines(40)));
    await engine.start('fan', {}, 'p');
    await until(() => transport.dispatched.length === 40);
    await until(async () => (await store.getRun('p'))?.status === 'suspended');
    calls.clear();
    await Promise.all(transport.take().map((t) => transport.deliver(ok(t))));
    await until(async () => (await store.getRun('p'))?.status === 'completed');
    expect(calls.get('saveCheckpointIfPending')).toBe(40);
    expect(calls.get('countCheckpoints')).toBe(1);
  });

  it('two instances settling halves of a fan each settle every step once and complete it', async () => {
    for (let round = 0; round < 5; round += 1) {
      const store = new InMemoryStateStore();
      const onA = new HeldTransport();
      const onB = new HeldTransport();
      const a = new WorkflowEngine({ store, transport: onA, reconcileMs: 0 });
      const b = new WorkflowEngine({ store, transport: onB, reconcileMs: 0 });
      const settled: number[] = [];
      for (const engine of [a, b]) {
        engine.register('fan', '1', async (ctx) => ctx.all(processLine, lines(100)));
        engine.subscribe((e) => {
          if (e.type === 'step.completed') settled.push(e.seq);
        });
      }
      await a.start('fan', {}, 'p');
      await until(() => onA.dispatched.length === 100);
      const tasks = onA.take();
      // Both instances get every result: an at-least-once broker redelivering to another pod.
      await Promise.all([
        ...tasks.map((t, i) => (i % 2 ? onA : onB).deliver(ok(t))),
        ...tasks.map((t, i) => (i % 2 ? onB : onA).deliver(ok(t))),
      ]);
      await until(async () => (await store.getRun('p'))?.status === 'completed');
      expect((await store.getRun('p'))?.output).toEqual(lines(100).map(({ i }) => i * 10));
      expect([...settled].sort((x, y) => x - y)).toEqual(tasks.map((t) => t.seq));
    }
  });
});
