import { describe, expect, it } from 'vitest';
import { CodecStateStore, type PayloadCodec } from './codec-state-store';
import { InMemoryStateStore } from './testing/in-memory-state-store';

// Same reversible codec as codec-state-store.spec.ts.
const wrapCodec: PayloadCodec = {
  encode: (v) => (v === undefined ? undefined : { __enc: JSON.stringify(v) }),
  decode: (v) =>
    v && typeof v === 'object' && '__enc' in v ? JSON.parse((v as { __enc: string }).__enc) : v,
};

describe('CodecStateStore namespace forwarding', () => {
  it('listPendingRuns forwards namespace to inner store', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, wrapCodec);
    const now = new Date('2026-06-26T00:00:00.000Z');
    const base = {
      workflow: 'wf',
      workflowVersion: '1',
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    };

    await store.createRun({ ...base, id: 'alpha-1', namespace: 'alpha' });
    await store.createRun({ ...base, id: 'beta-1', namespace: 'beta' });

    const alphaRuns = await store.listPendingRuns(10, 'alpha');
    expect(alphaRuns.map((r) => r.id)).toEqual(['alpha-1']);

    const allRuns = await store.listPendingRuns(10);
    expect(allRuns.map((r) => r.id).sort()).toEqual(['alpha-1', 'beta-1']);
  });
});
