import { describe, expect, it } from 'vitest';
import { CodecStateStore, type PayloadCodec } from './codec-state-store';
import { WorkflowEngine } from './engine';
import type {
  RemoteTask,
  StateStore,
  StepResult,
  StepSettlement,
  Transport,
  WorkflowEvent,
} from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A step's result changes its checkpoint's status, output, error, events and timings, never its
 * input. A step whose input is large (an LLM step carries the whole prompt) must not have that input
 * written a second time when its result lands.
 */

const ASK = 'llm.ask';
const PROMPT = { prompt: 'x'.repeat(100_000) };

class HeldTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
  deliver(result: StepResult): Promise<void> {
    if (!this.result) throw new Error('no result handler');
    return this.result(result);
  }
}

const CHECKPOINT_WRITES = new Set([
  'saveCheckpoint',
  'saveCheckpoints',
  'saveCheckpointIfPending',
  'saveCheckpointsIfPending',
  'settleCheckpointsIfPending',
]);

/** Counts the bytes every checkpoint write hands the store (its arguments, as JSON). */
function measured<T extends StateStore>(inner: T): { store: T; written: () => number } {
  let bytes = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (CHECKPOINT_WRITES.has(String(prop))) bytes += JSON.stringify(args).length;
        return value.apply(target, args);
      };
    },
  });
  return { store, written: () => bytes };
}

function setup(store: StateStore) {
  const transport = new HeldTransport();
  const engine = new WorkflowEngine({
    store,
    transports: [{ id: 't', transport }],
    reconcileMs: 0,
  });
  const events: WorkflowEvent[] = [];
  engine.subscribe((e) => events.push(e));
  let turns = 0;
  engine.register('wf', '1', async (ctx) => {
    turns += 1;
    return ctx.step<{ answer: string }>(ASK, PROMPT);
  });
  return { engine, transport, events, turns: () => turns };
}

const answer = (task: RemoteTask, output: unknown = { answer: 'yes' }): StepResult => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  status: 'completed',
  output,
  startedAt: Date.now(),
});

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

describe("a step's result settles its checkpoint without its input", () => {
  it('writes a few hundred bytes for a step with a 100 KB input, and keeps the input', async () => {
    const inner = new InMemoryStateStore();
    const { store, written } = measured(inner);
    const { engine, transport } = setup(store);
    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    const before = written();

    await transport.deliver(answer(task));
    await until(async () => (await inner.getRun('r1'))?.status === 'completed');

    expect(written() - before).toBeLessThan(1_000);
    const cp = await inner.getCheckpoint('r1', task.seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ answer: 'yes' });
    expect(cp?.input).toEqual(PROMPT);
    expect((await inner.getRun('r1'))?.output).toEqual({ answer: 'yes' });
  });

  it('a failed result keeps the input and records the error and events', async () => {
    const inner = new InMemoryStateStore();
    const { engine, transport, events } = setup(inner);
    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    await transport.deliver({
      runId: 'r1',
      seq: task.seq,
      stepId: task.stepId,
      status: 'failed',
      error: { message: 'model overloaded', retryable: false },
      events: [{ at: 1, level: 'error', message: 'overloaded' }],
    });
    await until(async () => (await inner.getRun('r1'))?.status === 'failed');
    const cp = await inner.getCheckpoint('r1', task.seq);
    expect(cp?.status).toBe('failed');
    expect(cp?.input).toEqual(PROMPT);
    expect(cp?.error).toEqual({ message: 'model overloaded', retryable: false });
    expect(cp?.events).toEqual([{ at: 1, level: 'error', message: 'overloaded' }]);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
  });

  it('a duplicate delivery loses the claim: the step settles and the run resumes once', async () => {
    const inner = new InMemoryStateStore();
    const { engine, transport, events, turns } = setup(inner);
    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;

    await Promise.all([
      transport.deliver(answer(task)),
      transport.deliver(answer(task, { answer: 'second copy' })),
    ]);
    await until(async () => (await inner.getRun('r1'))?.status === 'completed');
    await transport.deliver(answer(task, { answer: 'late copy' }));

    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
    expect((await inner.getCheckpoint('r1', task.seq))?.output).toEqual({ answer: 'yes' });
    expect((await inner.getRun('r1'))?.output).toEqual({ answer: 'yes' });
    expect(turns()).toBe(2);
  });

  it('a late result for a cancelled run does not settle its step', async () => {
    const inner = new InMemoryStateStore();
    const { engine, transport, events } = setup(inner);
    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    await engine.cancel('r1');
    await until(async () => (await inner.getRun('r1'))?.status === 'cancelled');

    await transport.deliver(answer(task));

    expect((await inner.getCheckpoint('r1', task.seq))?.status).toBe('pending');
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
  });

  it('a store without the settle still settles, writing the whole row', async () => {
    const inner = new InMemoryStateStore();
    Object.defineProperty(inner, 'settleCheckpointsIfPending', { value: undefined });
    const { store, written } = measured(inner);
    const { engine, transport } = setup(store);
    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    const before = written();
    await transport.deliver(answer(task));
    await until(async () => (await inner.getRun('r1'))?.status === 'completed');
    expect(written() - before).toBeGreaterThan(100_000);
    expect((await inner.getCheckpoint('r1', task.seq))?.input).toEqual(PROMPT);
  });
});

describe('CodecStateStore.settleCheckpointsIfPending', () => {
  const wrap: PayloadCodec = {
    encode: (v) => (v === undefined ? undefined : { __enc: JSON.stringify(v) }),
    decode: (v) =>
      v && typeof v === 'object' && '__enc' in v ? JSON.parse((v as { __enc: string }).__enc) : v,
  };

  it('encodes the output it settles, and leaves the stored input as it was encoded', async () => {
    const inner = new InMemoryStateStore();
    const seen: StepSettlement[] = [];
    const settle = inner.settleCheckpointsIfPending.bind(inner);
    inner.settleCheckpointsIfPending = async (settlements) => {
      seen.push(...settlements);
      return settle(settlements);
    };
    const store = new CodecStateStore(inner, wrap);
    const { engine, transport } = setup(store);
    await startRun(engine, 'wf', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    await transport.deliver(answer(task));
    await until(async () => (await inner.getRun('r1'))?.status === 'completed');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.output).toEqual({ __enc: JSON.stringify({ answer: 'yes' }) });
    expect(seen[0]).not.toHaveProperty('input');
    const raw = await inner.getCheckpoint('r1', task.seq);
    expect(raw?.output).toEqual({ __enc: JSON.stringify({ answer: 'yes' }) });
    expect(raw?.input).toEqual({ __enc: JSON.stringify(PROMPT) });
    const decoded = await store.getCheckpoint('r1', task.seq);
    expect(decoded?.output).toEqual({ answer: 'yes' });
    expect(decoded?.input).toEqual(PROMPT);
  });

  it('encodes events and error too under extended coverage', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, wrap, { coverage: 'extended' });
    const now = new Date();
    await store.saveCheckpoint({
      runId: 'r1',
      seq: 0,
      name: ASK,
      kind: 'remote',
      stepId: 'r1:0',
      status: 'pending',
      input: PROMPT,
      attempts: 1,
      enqueuedAt: now,
      startedAt: now,
      finishedAt: now,
    });
    expect(
      await store.settleCheckpointsIfPending?.([
        {
          runId: 'r1',
          seq: 0,
          status: 'failed',
          error: { message: 'boom' },
          events: [{ at: 1, level: 'info', message: 'hi' }],
          startedAt: now,
          finishedAt: now,
        },
      ]),
    ).toEqual([true]);
    const raw = await inner.getCheckpoint('r1', 0);
    expect(raw?.error).toEqual({ __enc: JSON.stringify({ message: 'boom' }) });
    expect(raw?.events).toEqual({
      __enc: JSON.stringify([{ at: 1, level: 'info', message: 'hi' }]),
    });
    const decoded = await store.getCheckpoint('r1', 0);
    expect(decoded?.error).toEqual({ message: 'boom' });
    expect(decoded?.input).toEqual(PROMPT);
  });

  it('is absent when the inner store has none', () => {
    const inner = new InMemoryStateStore();
    Object.defineProperty(inner, 'settleCheckpointsIfPending', { value: undefined });
    expect(new CodecStateStore(inner, wrap).settleCheckpointsIfPending).toBeUndefined();
  });
});
