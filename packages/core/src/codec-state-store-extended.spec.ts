import { describe, expect, it } from 'vitest';
import { CodecStateStore, type PayloadCodec } from './codec-state-store';
import { WorkflowEngine } from './engine';
import type { StepCheckpoint, StepError, StepEvent, WorkflowRun } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

// Reversible and pass-through: decode leaves values it didn't encode alone.
const wrapCodec: PayloadCodec = {
  encode: (v) => (v === undefined ? undefined : { __enc: JSON.stringify(v) }),
  decode: (v) =>
    v && typeof v === 'object' && '__enc' in v ? JSON.parse((v as { __enc: string }).__enc) : v,
};
const enc = (v: unknown) => ({ __enc: JSON.stringify(v) });

const at = new Date(1_700_000_000_000);
const runError: StepError = { message: 'card 4242 declined', code: 'declined' };
const stepError: StepError = { message: 'upstream said ssn-123 is invalid', retryable: false };
const events: StepEvent[] = [{ at: 1, level: 'info', message: 'charging card 4242' }];

const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'running',
  input: { secret: 'in' },
  error: runError,
  tags: ['t1'],
  searchAttributes: { tier: 'pro' },
  createdAt: at,
  updatedAt: at,
  ...over,
});

const cp = (seq: number, over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
  runId: 'r1',
  seq,
  name: `step-${seq}`,
  kind: 'local',
  stepId: `r1:${seq}`,
  status: 'failed',
  input: { a: seq },
  output: { b: seq },
  error: stepError,
  events,
  attempts: 1,
  enqueuedAt: at,
  startedAt: at,
  finishedAt: at,
  ...over,
});

const setup = (coverage?: 'payloads' | 'extended') => {
  const inner = new InMemoryStateStore();
  const store = new CodecStateStore(inner, wrapCodec, coverage ? { coverage } : undefined);
  return { inner, store };
};

describe('CodecStateStore coverage', () => {
  it("default ('payloads') leaves events and errors in the clear", async () => {
    for (const { inner, store } of [setup(), setup('payloads')]) {
      await store.createRun(run('r1'));
      await store.saveCheckpoint(cp(0));
      const raw = await inner.getRun('r1');
      expect(raw?.input).toEqual(enc({ secret: 'in' }));
      expect(raw?.error).toEqual(runError);
      const rawCp = await inner.getCheckpoint('r1', 0);
      expect(rawCp?.output).toEqual(enc({ b: 0 }));
      expect(rawCp?.error).toEqual(stepError);
      expect(rawCp?.events).toEqual(events);
      expect((await store.getCheckpoint('r1', 0))?.events).toEqual(events);
    }
  });

  it("'extended' encodes run error at rest on every run write path, metadata stays clear", async () => {
    const { inner, store } = setup('extended');
    await store.createRun(run('r1'));
    const raw = await inner.getRun('r1');
    expect(raw?.error).toEqual(enc(runError));
    expect(raw?.tags).toEqual(['t1']);
    expect(raw?.searchAttributes).toEqual({ tier: 'pro' });
    expect(raw?.status).toBe('running');

    const next: StepError = { message: 'second failure' };
    await store.updateRun('r1', { error: next });
    expect((await inner.getRun('r1'))?.error).toEqual(enc(next));

    const third: StepError = { message: 'third failure' };
    expect(await store.updateRunIf?.('r1', ['running'], { error: third })).toBe(true);
    expect((await inner.getRun('r1'))?.error).toEqual(enc(third));
    expect((await store.getRun('r1'))?.error).toEqual(third);

    // A patch without the key leaves the stored error alone.
    await store.updateRun('r1', { status: 'running' });
    expect((await inner.getRun('r1'))?.error).toEqual(enc(third));
  });

  it("'extended' clears the run error on an explicit `error: undefined` patch", async () => {
    const { inner, store } = setup('extended');
    await store.createRun(run('r1'));
    await store.updateRun('r1', { error: undefined });
    expect((await inner.getRun('r1'))?.error).toBeUndefined();
    expect((await store.getRun('r1'))?.error).toBeUndefined();

    await store.createRun(run('r2'));
    expect(await store.updateRunIf?.('r2', ['running'], { error: undefined })).toBe(true);
    expect((await inner.getRun('r2'))?.error).toBeUndefined();
    expect((await store.getRun('r2'))?.error).toBeUndefined();
  });

  it("'extended' decodes the run error on every run read path", async () => {
    const { store } = setup('extended');
    await store.createRun(run('running'));
    await store.createRun(run('pending', { status: 'pending' }));
    await store.createRun(run('timer', { status: 'suspended', wakeAt: 0 }));

    expect((await store.getRun('running'))?.error).toEqual(runError);
    for (const r of await store.listRuns({})) expect(r.error).toEqual(runError);
    expect((await store.listRuns({})).length).toBe(3);
    expect((await store.listIncompleteRuns()).map((r) => r.error)).toEqual([runError]);
    expect((await store.listOrphanedRuns?.(at.getTime(), 10))?.map((r) => r.error)).toEqual([
      runError,
    ]);
    expect((await store.listPendingRuns(10)).map((r) => r.error)).toEqual([runError]);
    expect((await store.listDueTimers(at.getTime())).map((r) => r.error)).toEqual([runError]);
  });

  it("'extended' encodes step events/error at rest on every checkpoint write path", async () => {
    const { inner, store } = setup('extended');
    const expectEncoded = async (seq: number) => {
      const raw = await inner.getCheckpoint('r1', seq);
      expect(raw?.events).toEqual(enc(events));
      expect(raw?.error).toEqual(enc(stepError));
      expect(raw?.input).toEqual(enc({ a: seq }));
      expect(raw?.name).toBe(`step-${seq}`);
      expect(raw?.status).toBe('failed');
    };

    await store.saveCheckpoint(cp(0));
    await expectEncoded(0);

    await store.saveCheckpoint(cp(1, { status: 'pending', error: undefined, events: undefined }));
    expect(await store.saveCheckpointIfPending?.(cp(1))).toBe(true);
    await expectEncoded(1);

    await store.saveCheckpoint(cp(2, { status: 'pending', error: undefined, events: undefined }));
    expect(await store.saveCheckpointsIfPending?.([cp(2)])).toEqual([true]);
    await expectEncoded(2);

    await store.registerChildWaits?.([
      { waiter: { token: 'child:x', runId: 'r1', seq: 3 }, checkpoint: cp(3) },
    ]);
    await expectEncoded(3);

    await store.transaction((tx) => tx.saveCheckpoint(cp(4)));
    await expectEncoded(4);

    await store.saveCheckpoint(cp(5));
    await store.saveCheckpoint(cp(6));
    await store.compactCheckpoints?.('r1', 5, 6, cp(5));
    await expectEncoded(5);
    expect(await inner.getCheckpoint('r1', 6)).toBeNull();
  });

  it("'extended' leaves absent events/error absent", async () => {
    const { inner, store } = setup('extended');
    await store.saveCheckpoint(cp(0, { status: 'completed', error: undefined, events: undefined }));
    const raw = await inner.getCheckpoint('r1', 0);
    expect(raw?.error).toBeUndefined();
    expect(raw?.events).toBeUndefined();
    const got = await store.getCheckpoint('r1', 0);
    expect(got?.error).toBeUndefined();
    expect(got?.events).toBeUndefined();

    await store.createRun(run('r1', { error: undefined }));
    expect((await inner.getRun('r1'))?.error).toBeUndefined();
    expect((await store.getRun('r1'))?.error).toBeUndefined();
  });

  it("'extended' decodes step events/error on every checkpoint read path", async () => {
    const { store } = setup('extended');
    await store.saveCheckpoint(cp(0));
    await store.saveCheckpoint(cp(1));
    const decoded = (c: StepCheckpoint | null | undefined) => {
      expect(c?.events).toEqual(events);
      expect(c?.error).toEqual(stepError);
      expect(c?.input).toEqual({ a: c?.seq });
    };

    decoded(await store.getCheckpoint('r1', 0));
    for (const c of await store.listCheckpoints('r1')) decoded(c);
    const queried = (await store.queryCheckpoints?.('r1', { statuses: ['failed'] })) ?? [];
    expect(queried.length).toBe(2);
    for (const c of queried) decoded(c);
    decoded(await store.getLatestCheckpointByName('r1', 'step-1'));
    const byPrefix = await store.listCheckpointsByNamePrefix('r1', ['step-']);
    expect(byPrefix.length).toBe(2);
    for (const c of byPrefix) decoded(c);
  });

  it('a failing workflow under an extended codec reports the decoded error via engine.getRun', async () => {
    const inner = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store: new CodecStateStore(inner, wrapCodec, { coverage: 'extended' }),
    });
    engine.register('wf', '1', async () => {
      throw new Error('card 4242 declined');
    });

    const res = await startRun(engine, 'wf', { n: 1 }, 'r-fail');
    expect(res.status).toBe('failed');

    const raw = await inner.getRun('r-fail');
    expect(raw?.status).toBe('failed');
    expect(raw?.error).toHaveProperty('__enc');

    const got = await engine.getRun('r-fail');
    expect(got?.status).toBe('failed');
    expect(got?.error?.message).toBe('card 4242 declined');
  });
});
