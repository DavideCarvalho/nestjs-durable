import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { StepCheckpoint, WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A run awaiting an IN-FLIGHT remote step must not be dead-lettered by orphan recovery.
 *
 * `recoverIncomplete` treats "the lease is acquirable" as "the worker crashed". That inference does
 * not hold for a run whose remote step is still being executed by a live worker: the work sits on
 * the transport and nobody holds the RUN lease while it does. By the lib's own contract such a run
 * is durably SUSPENDED (`StepCheckpoint.status`: `pending` = "dispatched and awaiting its worker
 * result — the run is durably suspended, not held in memory"), so finding it `running` means a turn
 * ended without restoring that invariant. Each recovery pass over it used to increment
 * `recoveryAttempts`, so enough passes dead-lettered the run with a generic `max_recovery_attempts`
 * error while its worker was still happily processing.
 *
 * Observed in the wild (flip, 2026-07-24): an ingestion run reached `recoveryAttempts: 10` and
 * `dead` in 57 seconds while its `runIngestionRead` job was `active` on the queue and its handler
 * had already logged progress.
 */
describe('recoverIncomplete with an in-flight pending remote step', () => {
  const at = new Date();

  const runningRun = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    // The anomalous-but-real state: left `running` (not `suspended`) with the lease released, so
    // `listIncompleteRuns` returns it and `tryLockRun` succeeds.
    status: 'running',
    input: {},
    createdAt: at,
    updatedAt: at,
    ...over,
  });

  const pendingRemoteStep = (runId: string): StepCheckpoint => ({
    runId,
    seq: 0,
    name: 'IngestionReadService.runIngestionRead',
    kind: 'remote',
    stepId: `${runId}:0`,
    status: 'pending', // dispatched, a live worker is executing it
    attempts: 1,
    workerGroup: 'IngestionReadService.runIngestionRead',
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
  });

  it('does not burn the poison-pill budget on a run whose step is on the transport', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
    });
    await store.createRun(runningRun('r1'));
    await store.saveCheckpoint(pendingRemoteStep('r1'));

    for (let i = 0; i < 12; i++) await engine.recoverIncomplete();

    const run = await store.getRun('r1');
    expect(run?.status).not.toBe('dead');
    expect(run?.recoveryAttempts ?? 0).toBe(0);
  });

  it('re-asserts the durably-suspended invariant so the run leaves the orphan sweep entirely', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
      reconcileMs: 300_000,
    });
    await store.createRun(runningRun('r1'));
    await store.saveCheckpoint(pendingRemoteStep('r1'));

    const [result] = await engine.recoverIncomplete();

    expect(result).toEqual({ runId: 'r1', status: 'suspended' });
    const run = await store.getRun('r1');
    expect(run?.status).toBe('suspended'); // where a dispatched-and-waiting run belongs
    expect(run?.wakeAt).toBeGreaterThan(0); // on the reconcile timer, so it is never orphaned
    expect(run?.lockedBy ?? null).toBeNull(); // lease handed back
    // …and it is no longer a candidate for the orphan sweep at all.
    expect(await store.listIncompleteRuns()).toEqual([]);
  });

  it('still dead-letters a genuine poison pill — a run with no dispatched step in flight', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 3,
    });
    await store.createRun(runningRun('r2'));

    // A real poison pill kills the process mid-turn, so each recovery re-drive puts the run back to
    // `running` and it is orphaned again — that re-entry is what the counter exists to bound. (A
    // no-op dispatcher leaves the run `pending`, which no sweep would ever look at again, so the
    // crash has to be simulated explicitly.)
    for (let i = 0; i < 5; i++) {
      await engine.recoverIncomplete();
      if ((await store.getRun('r2'))?.status === 'pending') {
        await store.updateRun('r2', { status: 'running', updatedAt: new Date() });
      }
    }

    const run = await store.getRun('r2');
    expect(run?.status).toBe('dead');
    expect(run?.error?.code).toBe('max_recovery_attempts');
  });

  it('still dead-letters a poison pill whose remote steps have all SETTLED', async () => {
    // The guard keys on an *in-flight* (`pending`) remote step. A run that crash-loops after its
    // dispatched step completed has no excuse, and must still die.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 2,
    });
    await store.createRun(runningRun('r3'));
    await store.saveCheckpoint({ ...pendingRemoteStep('r3'), status: 'completed', output: {} });

    for (let i = 0; i < 4; i++) {
      await engine.recoverIncomplete();
      if ((await store.getRun('r3'))?.status === 'pending') {
        await store.updateRun('r3', { status: 'running', updatedAt: new Date() });
      }
    }

    expect((await store.getRun('r3'))?.status).toBe('dead');
  });
});
