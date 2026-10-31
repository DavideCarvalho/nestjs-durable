import { describe, expect, it, vi } from 'vitest';
import { type SingletonConfig, WorkflowEngine } from './engine';
import type { WorkflowRun } from './interfaces';
import { SINGLETON_TRACKED_TAG } from './singleton-admission';
import { isLockConflict } from './singleton-gate';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const deadlock = () =>
  Object.assign(new Error('Failed query'), { cause: { code: '40P01', message: 'deadlock' } });

function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  let executed = 0;
  engine.register(
    'job',
    '1',
    async () => {
      executed += 1;
      return 'done';
    },
    { singleton: { key: () => 'k' } },
  );
  return { store, engine, executed: () => executed };
}

type Gate = { admit(run: WorkflowRun | null, cfg: SingletonConfig): Promise<boolean> };
const gateOf = (engine: WorkflowEngine) => (engine as unknown as { singletons: Gate }).singletons;

const settled = async (store: InMemoryStateStore, id: string) => {
  for (let i = 0; i < 500; i += 1) {
    const run = await store.getRun(id);
    if (run && run.status !== 'pending' && !run.lockedBy) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run did not settle');
};

describe('a singleton claim the database aborts as a lock conflict', () => {
  it('is retried, and the run executes', async () => {
    const { store, engine, executed } = setup();
    const admit = store.tryAdmitSingleton.bind(store);
    const spy = vi
      .spyOn(store, 'tryAdmitSingleton')
      .mockRejectedValueOnce(deadlock())
      .mockImplementation(admit);
    await startRun(engine, 'job', {}, 'r');
    expect((await settled(store, 'r')).status).toBe('completed');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(executed()).toBe(1);
    await engine.drain();
  });

  it('parks the run on its retry timer with its lease released once retries run out', async () => {
    const { store, engine, executed } = setup();
    const spy = vi.spyOn(store, 'tryAdmitSingleton').mockRejectedValue(deadlock());
    await startRun(engine, 'job', {}, 'r');
    const run = await settled(store, 'r');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(run.status).toBe('suspended');
    expect(run.wakeAt).toBeTypeOf('number');
    expect(run.lockedUntil ?? 0).toBe(0);
    expect(run.tags).toContain(SINGLETON_TRACKED_TAG);
    expect(executed()).toBe(0);
    await engine.drain();
  });

  it('never revives a cancelling run', async () => {
    const { store, engine } = setup();
    await startRun(engine, 'job', {}, 'done');
    await settled(store, 'done');
    await store.updateRun('done', { status: 'cancelling' });
    const gate = gateOf(engine);
    vi.spyOn(store, 'tryAdmitSingleton').mockRejectedValue(deadlock());
    const run = await store.getRun('done');
    expect(await gate.admit(run, { key: () => 'k' })).toBe(false);
    expect((await store.getRun('done'))?.status).toBe('cancelling');
    await engine.drain();
  });

  it('recognises each driver shape, and nothing else', () => {
    expect(isLockConflict({ code: '40P01' })).toBe(true);
    expect(isLockConflict({ driverError: { code: 'ER_LOCK_DEADLOCK' } })).toBe(true);
    expect(isLockConflict({ errno: 1213 })).toBe(true);
    expect(isLockConflict({ code: 'P2010', meta: { code: '40P01' } })).toBe(true);
    expect(isLockConflict({ code: 'P2034' })).toBe(true);
    expect(isLockConflict(new Error('boom'))).toBe(false);
    expect(isLockConflict({ code: '23505' })).toBe(false);
  });

  it('still throws any other store failure', async () => {
    const { store, engine } = setup();
    await store.createRun({
      id: 'x',
      workflow: 'job',
      workflowVersion: '1',
      status: 'running',
      input: {},
      attempts: 0,
      tags: ['singleton:k'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const gate = gateOf(engine);
    vi.spyOn(store, 'tryAdmitSingleton').mockRejectedValue(new Error('boom'));
    await expect(gate.admit(await store.getRun('x'), { key: () => 'k' })).rejects.toThrow('boom');
    await engine.drain();
  });
});
