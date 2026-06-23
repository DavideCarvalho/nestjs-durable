import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowDecision, WorkflowRun } from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function waitForStatus(
  store: InMemoryStateStore,
  runId: string,
  status: string,
  ticks = 100,
) {
  for (let i = 0; i < ticks && (await store.getRun(runId))?.status !== status; i += 1) await tick();
  return (await store.getRun(runId))?.status;
}

// A saga workflow that completes one compensable step, then suspends on a signal mid-saga.
function registerSaga(engine: WorkflowEngine, undone: string[], compGate?: Promise<void>) {
  engine.register('saga', '1', async (ctx) => {
    await ctx.step('reserve', async () => 'r', {
      compensate: async () => {
        if (compGate) await compGate;
        undone.push('reserve');
      },
    });
    await ctx.waitForSignal('ship');
    return 'done';
  });
}

describe('RunStatus cancelling — compensating cancel is visible + durable', () => {
  it('cancel({compensate}) returns `cancelling` immediately, then settles `cancelled` after the undo', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const undone: string[] = [];
    registerSaga(engine, undone);

    await startRun(engine, 'saga', {}, 'r1');
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    // Synchronous return is `cancelling` (NOT the old `suspended`, and NOT yet `cancelled`).
    const res = await engine.cancel('r1', { compensate: true });
    expect(res?.status).toBe('cancelling');

    expect(await waitForStatus(store, 'r1', 'cancelled')).toBe('cancelled');
    expect(undone).toEqual(['reserve']); // the saga undo ran
  });

  it('persists `cancelling` WHILE the undo runs; a repeat cancel is idempotent (undo once)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const undone: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    registerSaga(engine, undone, gate);

    await startRun(engine, 'saga', {}, 'r1');
    const first = await engine.cancel('r1', { compensate: true });
    expect(first?.status).toBe('cancelling');

    // The background resume is blocked inside the compensation (on `gate`) — the run is observably
    // `cancelling`, not `running`/`suspended` and not yet `cancelled`.
    expect(await waitForStatus(store, 'r1', 'cancelling')).toBe('cancelling');

    // A second compensating cancel while already cancelling is idempotent: it echoes `cancelling`
    // and must NOT re-queue the undo or short-circuit to `cancelled`.
    const second = await engine.cancel('r1', { compensate: true });
    expect(second?.status).toBe('cancelling');

    release();
    expect(await waitForStatus(store, 'r1', 'cancelled')).toBe('cancelled');
    expect(undone).toEqual(['reserve']); // exactly once despite two cancels
  });

  it('recovery re-drives a crashed `cancelling` run to `cancelled` (durable cancel)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    registerSaga(engine, []);
    await startRun(engine, 'saga', {}, 'r1');

    // Simulate a crash MID-compensation: the run is persisted `cancelling` but the in-memory cancel
    // flag + lease are gone. A fresh engine must recover it and finish the cancel from the status alone.
    await store.updateRun('r1', {
      status: 'cancelling',
      lockedBy: undefined,
      lockedUntil: undefined,
    });

    const recovered = new WorkflowEngine({ store });
    const undone2: string[] = [];
    registerSaga(recovered, undone2);
    await recovered.recoverIncomplete();

    expect(await waitForStatus(store, 'r1', 'cancelled')).toBe('cancelled');
    expect(undone2).toEqual(['reserve']); // compensation ran on the recovering instance
  });

  it('a `cancelling` run whose replay COMPLETES (no suspension point) still settles cancelled', async () => {
    // Finding-1 guard: compensation lived only in the WorkflowSuspended branch, so a cancel on a run
    // that returns before suspending would silently settle `completed` and lose the cancel. The body
    // here has no suspension — on replay it runs straight to `return`, exercising the completed path.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const undone: string[] = [];
    engine.register('quick', '1', async (ctx) => {
      await ctx.step('reserve', async () => 'r', {
        compensate: async () => {
          undone.push('reserve');
        },
      });
      return 'done';
    });
    await startRun(engine, 'quick', {}, 'r1');
    expect((await store.getRun('r1'))?.status).toBe('completed'); // reserve checkpointed

    // A compensating cancel landed while in-flight (status `cancelling`); on the re-driven turn the
    // replay completes rather than suspending — it must STILL compensate + settle cancelled.
    await store.updateRun('r1', {
      status: 'cancelling',
      lockedBy: undefined,
      lockedUntil: undefined,
    });
    await engine.recoverIncomplete();

    expect(await waitForStatus(store, 'r1', 'cancelled')).toBe('cancelled');
    expect(undone).toEqual(['reserve']); // undo ran even though the body returns on replay
  });

  it('compensating cancel of a REMOTE workflow goes `cancelling` → `cancelled`', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const engine = new WorkflowEngine({ store, transport });
    // A remote workflow that never completes on its own (always `continue`) — it sits suspended until cancelled.
    engine.registerRemote('proc', '1', {
      group: 'py',
      executor: {
        async advance(run: WorkflowRun): Promise<WorkflowDecision> {
          return { taskId: 't', runId: run.id, status: 'continue', commands: [] };
        },
      },
    });

    await engine.start('proc', {}, 'p1');
    expect(await waitForStatus(store, 'p1', 'suspended')).toBe('suspended');

    const res = await engine.cancel('p1', { compensate: true });
    expect(res?.status).toBe('cancelling');

    // The remote path has no TS-side compensations, so a `cancelling` remote run finalizes to cancelled.
    expect(await waitForStatus(store, 'p1', 'cancelled')).toBe('cancelled');
  });
});
