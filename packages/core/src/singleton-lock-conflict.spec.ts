import { describe, expect, it, vi } from 'vitest';
import { type SingletonConfig, WorkflowEngine } from './engine';
import type { WorkflowRun } from './interfaces';
import { SINGLETON_ADMITTED_TAG } from './singleton-admission';
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

const run = (id: string, tags: string[]): WorkflowRun => ({
  id,
  workflow: 'job',
  workflowVersion: '1',
  status: 'running',
  input: {},
  attempts: 0,
  tags,
  createdAt: new Date(1),
  updatedAt: new Date(1),
});

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

  it('once retries run out, releases the lease and writes nothing, and a sweep re-drives it', async () => {
    const { store, engine, executed } = setup();
    const admit = store.tryAdmitSingleton.bind(store);
    const spy = vi.spyOn(store, 'tryAdmitSingleton').mockRejectedValue(deadlock());
    await engine.start('job', {}, 'r');
    const run = await settled(store, 'r');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(run.status).toBe('running');
    expect(run.lockedBy).toBeUndefined();
    expect(executed()).toBe(0);
    spy.mockImplementation(admit);
    await engine.recoverIncomplete();
    expect((await settled(store, 'r')).status).toBe('completed');
    await engine.drain();
  });

  it('a parked run that hits them on resume is re-driven by its timer', async () => {
    const { store, engine, executed } = setup();
    await store.createRun(run('holder', ['singleton:k', SINGLETON_ADMITTED_TAG]));
    await startRun(engine, 'job', {}, 'waiter');
    const parked = await settled(store, 'waiter');
    expect(parked.status).toBe('suspended');
    await store.updateRun('holder', { status: 'completed' });
    const admit = store.tryAdmitSingleton.bind(store);
    const spy = vi.spyOn(store, 'tryAdmitSingleton').mockRejectedValue(deadlock());
    const due = (parked.wakeAt ?? 0) + 1;
    await engine.resumeDueTimers(due);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockImplementation(admit);
    await engine.resumeDueTimers(due);
    await engine.recoverIncomplete(due);
    expect((await settled(store, 'waiter')).status).toBe('completed');
    expect(executed()).toBe(1);
    await engine.drain();
  });

  it('never touches a run another instance took over during the claim', async () => {
    const { store, engine, executed } = setup();
    const taken = ['singleton:k', SINGLETON_ADMITTED_TAG];
    const spy = vi.spyOn(store, 'tryAdmitSingleton').mockImplementation(async (id) => {
      // This turn's lease lapses mid-claim: another instance is admitted and holds the run.
      await store.updateRun(id, {
        tags: taken,
        lockedBy: 'other',
        lockedUntil: Date.now() + 60_000,
      });
      throw deadlock();
    });
    await engine.start('job', {}, 'r');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    await engine.drain();
    const run = await store.getRun('r');
    expect(run?.status).toBe('running');
    expect(run?.tags).toEqual(taken);
    expect(run?.lockedBy).toBe('other');
    expect(executed()).toBe(0);
  });

  it('recognises each driver shape, and nothing else', () => {
    expect(isLockConflict({ code: '40P01' })).toBe(true);
    expect(isLockConflict({ driverError: { code: 'ER_LOCK_DEADLOCK' } })).toBe(true);
    expect(isLockConflict({ errno: 1213 })).toBe(true);
    expect(isLockConflict({ code: 'P2010', meta: { code: '40P01' } })).toBe(true);
    expect(isLockConflict({ code: 'P2034' })).toBe(true);
    // Prisma driver adapters, 6 and 7.
    expect(
      isLockConflict({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } },
      }),
    ).toBe(true);
    expect(
      isLockConflict({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { kind: 'postgres', originalCode: '40P01' } } },
      }),
    ).toBe(true);
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
