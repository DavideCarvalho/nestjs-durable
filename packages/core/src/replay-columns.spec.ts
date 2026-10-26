import { describe, expect, it } from 'vitest';
import { CodecStateStore, type PayloadCodec } from './codec-state-store';
import { WorkflowEngine } from './engine';
import type { RemoteTask, StateStore, StepResult, Transport } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A turn replays a run's completed steps from their outputs, so it reads them without their input. A
 * conversation whose every turn is an LLM step with the whole prompt as input otherwise re-reads
 * every earlier prompt on every resume. A step still open (re-dispatch) or failed (retry) keeps its
 * input, and the reads outside replay (run detail, retry) still see every input.
 */

const ASK = 'llm.ask';
const prompt = (turn: number) => ({ turn, prompt: 'x'.repeat(100_000) });

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

const CHECKPOINT_READS = new Set([
  'getCheckpoint',
  'getCheckpoints',
  'listCheckpoints',
  'listCheckpointsForReplay',
  'listCheckpointsByNamePrefix',
  'queryCheckpoints',
]);

/** Counts the bytes of the checkpoints every read hands back, and the calls by method. */
function measured<T extends StateStore>(inner: T) {
  let bytes = 0;
  const calls = new Map<string, number>();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const name = String(prop);
      return async (...args: unknown[]) => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        const out = await value.apply(target, args);
        if (CHECKPOINT_READS.has(name)) bytes += JSON.stringify(out ?? null).length;
        return out;
      };
    },
  });
  return { store, read: () => bytes, calls };
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

const answer = (task: RemoteTask): StepResult => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  status: 'completed',
  output: { answer: task.seq },
});

function conversation(store: StateStore, turns: number) {
  const transport = new HeldTransport();
  const engine = new WorkflowEngine({
    store,
    transports: [{ id: 't', transport }],
    reconcileMs: 0,
  });
  engine.register('chat', '1', async (ctx) => {
    const answers: unknown[] = [];
    for (let i = 0; i < turns; i += 1) answers.push(await ctx.step(ASK, prompt(i)));
    return answers;
  });
  return { engine, transport };
}

describe('a turn replays completed steps without their input', () => {
  it("a resume reads the settled step once, and none of the earlier steps' inputs", async () => {
    const inner = new InMemoryStateStore();
    const { store, read } = measured(inner);
    const { engine, transport } = conversation(store, 6);
    await startRun(engine, 'chat', {}, 'c1');
    const perResume: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await until(() => transport.dispatched.length === i + 1);
      const before = read();
      await transport.deliver(answer(transport.dispatched[i] as RemoteTask));
      await until(async () => {
        const status = (await inner.getRun('c1'))?.status;
        return transport.dispatched.length === i + 2 || status === 'completed';
      });
      await until(async () => (await inner.getRun('c1'))?.status !== 'running');
      perResume.push(read() - before);
    }
    expect((await inner.getRun('c1'))?.status).toBe('completed');
    // Reading the step a result settles costs its input once; replaying the five steps before the
    // last one costs none of theirs.
    for (const bytes of perResume) expect(bytes).toBeLessThan(150_000);
  });

  it('the run detail and the full read still carry every input', async () => {
    const inner = new InMemoryStateStore();
    const { engine, transport } = conversation(inner, 2);
    await startRun(engine, 'chat', {}, 'c1');
    await transport.deliver(answer(transport.dispatched[0] as RemoteTask));
    await until(() => transport.dispatched.length === 2);
    await transport.deliver(answer(transport.dispatched[1] as RemoteTask));
    await until(async () => (await inner.getRun('c1'))?.status === 'completed');
    const listed = await engine.listCheckpoints('c1');
    expect(listed.map((cp) => cp.input)).toEqual([prompt(0), prompt(1)]);
  });

  it("a pending step's input still reaches its redispatch", async () => {
    let now = 1_000_000;
    const inner = new InMemoryStateStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({
      store: inner,
      transports: [{ id: 't', transport }],
      clock: () => now,
      reconcileMs: 0,
      remoteRedispatchMs: 60_000,
    });
    engine.register('chat', '1', async (ctx) => {
      await ctx.step(ASK, prompt(0));
      return ctx.step(ASK, prompt(1));
    });
    await startRun(engine, 'chat', {}, 'c1');
    await transport.deliver(answer(transport.dispatched[0] as RemoteTask));
    await until(() => transport.dispatched.length === 2);
    await until(async () => (await inner.getRun('c1'))?.status === 'suspended');
    // A replay stamps the second step's lease; once it lapses, the next replay re-dispatches it.
    await engine.runOne('c1');
    now += 120_000;
    await engine.runOne('c1');

    expect(transport.dispatched).toHaveLength(3);
    expect(transport.dispatched[2]?.seq).toBe(transport.dispatched[1]?.seq);
    expect(transport.dispatched[2]?.input).toEqual(prompt(1));
    expect((await inner.getCheckpoint('c1', 0))?.input).toEqual(prompt(0));
  });

  it("a failed step's retry keeps the input stored on its checkpoint", async () => {
    let now = 1_000_000;
    const inner = new InMemoryStateStore();
    const transport = new HeldTransport();
    const engine = new WorkflowEngine({
      store: inner,
      transports: [{ id: 't', transport }],
      clock: () => now,
      reconcileMs: 0,
    });
    engine.register('chat', '1', async (ctx) =>
      ctx.step(ASK, prompt(0), { retries: 2, backoffMs: 1_000 }),
    );
    await startRun(engine, 'chat', {}, 'c1');
    const task = transport.dispatched[0] as RemoteTask;
    await transport.deliver({
      runId: 'c1',
      seq: task.seq,
      stepId: task.stepId,
      status: 'failed',
      error: { message: 'overloaded', retryable: true },
    });
    await until(async () => (await inner.getRun('c1'))?.status === 'suspended');
    expect((await inner.getCheckpoint('c1', task.seq))?.wakeAt).toBeDefined();
    expect((await inner.getCheckpoint('c1', task.seq))?.input).toEqual(prompt(0));
    now += 60_000;
    await engine.runOne('c1');
    expect(transport.dispatched[1]?.input).toEqual(prompt(0));
  });

  it('a store without the replay read gets the full listing', async () => {
    const inner = new InMemoryStateStore();
    Object.defineProperty(inner, 'listCheckpointsForReplay', { value: undefined });
    const { store, calls } = measured(inner);
    const { engine, transport } = conversation(store, 2);
    await startRun(engine, 'chat', {}, 'c1');
    await transport.deliver(answer(transport.dispatched[0] as RemoteTask));
    await until(() => transport.dispatched.length === 2);
    await transport.deliver(answer(transport.dispatched[1] as RemoteTask));
    await until(async () => (await inner.getRun('c1'))?.status === 'completed');
    expect(calls.get('listCheckpoints')).toBeGreaterThan(0);
  });
});

describe('CodecStateStore.listCheckpointsForReplay', () => {
  const wrap: PayloadCodec = {
    encode: (v) => (v === undefined ? undefined : { __enc: JSON.stringify(v) }),
    decode: (v) =>
      v && typeof v === 'object' && '__enc' in v ? JSON.parse((v as { __enc: string }).__enc) : v,
  };

  it('decodes what it reads, and is absent when the inner store has none', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, wrap);
    const now = new Date();
    const base = {
      runId: 'r1',
      name: ASK,
      kind: 'remote' as const,
      attempts: 1,
      enqueuedAt: now,
      startedAt: now,
      finishedAt: now,
    };
    await store.saveCheckpoint({
      ...base,
      seq: 0,
      stepId: 'r1:0',
      status: 'completed',
      input: prompt(0),
      output: { answer: 0 },
    });
    await store.saveCheckpoint({
      ...base,
      seq: 1,
      stepId: 'r1:1',
      status: 'pending',
      input: prompt(1),
    });
    const replay = (await store.listCheckpointsForReplay?.('r1')) ?? [];
    expect(replay.map((cp) => [cp.output, cp.input])).toEqual([
      [{ answer: 0 }, undefined],
      [undefined, prompt(1)],
    ]);

    Object.defineProperty(inner, 'listCheckpointsForReplay', { value: undefined });
    expect(new CodecStateStore(inner, wrap).listCheckpointsForReplay).toBeUndefined();
  });
});
