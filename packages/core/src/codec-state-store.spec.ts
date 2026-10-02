import { describe, expect, it } from 'vitest';
import { CodecStateStore, type PayloadCodec } from './codec-state-store';
import { WorkflowEngine } from './engine';
import { SINGLETON_ADMITTED_TAG } from './singleton-admission';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

// A reversible codec that wraps the value so we can prove it was applied at rest.
const wrapCodec: PayloadCodec = {
  encode: (v) => (v === undefined ? undefined : { __enc: JSON.stringify(v) }),
  decode: (v) =>
    v && typeof v === 'object' && '__enc' in v ? JSON.parse((v as { __enc: string }).__enc) : v,
};

describe('CodecStateStore', () => {
  it('forwards atomic singleton claims without encoding metadata or decoding input', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, wrapCodec);
    const now = new Date();
    await store.createRun({
      id: 'holder',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: { secret: 'value' },
      tags: ['singleton:k'],
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.tryAdmitSingleton?.('holder', 'singleton:k', 'wf', 1)).toBe(true);
    expect((await inner.getRun('holder'))?.tags).toEqual(['singleton:k', SINGLETON_ADMITTED_TAG]);
    expect((await inner.getRun('holder'))?.input).toEqual({
      __enc: JSON.stringify({ secret: 'value' }),
    });
    await store.createRun({
      id: 'waiter',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'running',
      input: {},
      tags: ['singleton:k'],
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.tryAdmitSingleton?.('waiter', 'singleton:k', 'wf', 1)).toBe(false);
    await store.updateRun('holder', { status: 'completed' });
    expect(await store.tryAdmitSingleton?.('waiter', 'singleton:k', 'wf', 1)).toBe(true);
  });

  it('preserves absence of atomic singleton support in the underlying store', () => {
    const inner = new InMemoryStateStore();
    Object.defineProperty(inner, 'tryAdmitSingleton', { value: undefined });
    expect(new CodecStateStore(inner, wrapCodec).tryAdmitSingleton).toBeUndefined();
  });

  it('encodes payloads at rest and decodes them on read', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, wrapCodec);
    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'completed',
      input: { secret: 'ssn-123' },
      output: { ok: true },
      createdAt: now,
      updatedAt: now,
    });

    // At rest (inner store) the payload is encoded…
    const raw = await inner.getRun('r1');
    expect(raw?.input).toEqual({ __enc: JSON.stringify({ secret: 'ssn-123' }) });
    // …and reading through the codec decodes it.
    const got = await store.getRun('r1');
    expect(got?.input).toEqual({ secret: 'ssn-123' });
    expect(got?.output).toEqual({ ok: true });
  });

  it('runs a workflow end-to-end through the codec (step outputs encoded at rest)', async () => {
    const inner = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store: new CodecStateStore(inner, wrapCodec) });
    engine.register('wf', '1', async (ctx, input) => {
      const a = await ctx.localStep('a', async () => ({ doubled: (input as { n: number }).n * 2 }));
      return a;
    });

    const res = await startRun(engine, 'wf', { n: 21 }, 'r2');
    expect(res.status).toBe('completed');
    expect(res.output).toEqual({ doubled: 42 });
    // The checkpoint's output is encoded in the underlying store.
    const cp = await inner.getCheckpoint('r2', 0);
    expect(cp?.output).toHaveProperty('__enc');
  });
});
