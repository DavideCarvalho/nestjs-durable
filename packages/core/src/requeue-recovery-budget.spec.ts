import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type { WorkflowRun } from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * Retrying a dead-lettered run has to actually resurrect it.
 *
 * `requeue` resets the failure state its docstring promises to reset — the failed checkpoints, the
 * stale `error` — but it used to leave the run-level `recoveryAttempts` at the cap. So a run
 * dead-lettered at `maxRecoveryAttempts` came back `pending`, and the very next `recoverIncomplete`
 * pass computed `cap + 1` and dead-lettered it again within seconds: the retry was accepted, the run
 * was re-killed with the same generic `max_recovery_attempts` error, and nothing ever progressed.
 *
 * Observed in the wild (flip, `maxRecoveryAttempts: 10`): POST …/retry returned
 * `{"status":"pending"}` and ~1 minute later the run was `dead` again with `recoveryAttempts: 10`.
 */
describe('requeue restores the recovery budget', () => {
  const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
    id: 'r1',
    workflow: 'wf',
    workflowVersion: '1',
    status: 'dead',
    input: {},
    error: { message: 'exceeded', code: 'max_recovery_attempts' },
    recoveryAttempts: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  it('clears recoveryAttempts when resurrecting a dead run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
    });
    await store.createRun(run());

    expect(await engine.requeue('r1')).toEqual({ runId: 'r1', status: 'pending' });

    const after = await store.getRun('r1');
    expect(after?.status).toBe('pending');
    expect(after?.recoveryAttempts).toBe(0); // a real value, not `undefined` — stores disagree on that
    expect(after?.error).toBeUndefined();
  });

  it('clears it for a `failed` run too', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
    });
    await store.createRun(run({ status: 'failed', error: { message: 'boom' } }));

    await engine.requeue('r1');

    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(0);
  });

  it('survives the next orphan-recovery pass instead of being re-killed on the spot', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
    });
    await store.createRun(run()); // dead, AT the cap

    await engine.requeue('r1');
    // The worker picks it up and dies once, so the run is orphaned `running` and the sweep sees it.
    // Pre-fix this pass computed 10 + 1 > 10 and dead-lettered it again immediately.
    await store.updateRun('r1', { status: 'running', updatedAt: new Date() });
    await engine.recoverIncomplete();

    const after = await store.getRun('r1');
    expect(after?.status).not.toBe('dead');
    expect(after?.recoveryAttempts).toBe(1); // a FRESH budget, spending its first attempt
  });

  it('actually re-executes and completes the resurrected run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, maxRecoveryAttempts: 10 });
    let ran = 0;
    engine.register('wf', '1', async () => {
      ran += 1;
      return 'ok';
    });
    await store.createRun(run());

    await engine.requeue('r1');
    const settled = await engine.waitForRun('r1');

    expect(ran).toBe(1);
    expect(settled.status).toBe('completed');
    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(0);
  });

  it('does NOT clear it for a run that is still in flight — the poison-pill bound has to hold', async () => {
    // Requeueing a `running`/`suspended` run is not a resurrection: it never came to rest. Zeroing
    // there would let a retry loop keep a genuinely crash-looping run alive forever.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
    });
    await store.createRun(run({ status: 'running', error: undefined }));

    await engine.requeue('r1');

    expect((await store.getRun('r1'))?.recoveryAttempts).toBe(10); // budget untouched
  });

  it('a genuine poison pill still dies after a retry spends the fresh budget', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 2,
    });
    await store.createRun(run({ recoveryAttempts: 2 }));

    await engine.requeue('r1'); // fresh budget…
    for (let i = 0; i < 4; i++) {
      // …which a run that keeps crashing (orphaned `running` every time) still burns through.
      await store.updateRun('r1', { status: 'running', updatedAt: new Date() });
      await engine.recoverIncomplete();
    }

    const after = await store.getRun('r1');
    expect(after?.status).toBe('dead');
    expect(after?.error?.code).toBe('max_recovery_attempts');
  });

  it('cascades the reset to a dead child requeued with its parent', async () => {
    // The `signal:child:` cascade calls requeue recursively, so the child must get the same clean
    // budget — otherwise retrying the pair resurrects the parent and leaves the child unrecoverable.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
    });
    await store.createRun(run({ id: 'parent' }));
    await store.createRun(run({ id: 'child', workflow: 'child-wf' }));
    const at = new Date();
    await store.saveCheckpoint({
      runId: 'parent',
      seq: 0,
      name: 'signal:child:child',
      kind: 'signal',
      stepId: 'parent:0',
      status: 'completed',
      output: { ok: false, error: 'child failed' },
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });

    await engine.requeue('parent');

    expect((await store.getRun('parent'))?.recoveryAttempts).toBe(0);
    const child = await store.getRun('child');
    expect(child?.status).toBe('pending');
    expect(child?.recoveryAttempts).toBe(0);
  });

  it('retryWithInput starts the replacement run on a clean budget', async () => {
    // `retryWithInput` never touches the original — it starts a NEW run id — so the budget is clean
    // by construction. Pinned here so a future change can't quietly carry the counter across.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      runDispatcher: { dispatch: () => {} },
      maxRecoveryAttempts: 10,
    });
    engine.register('wf', '1', async () => 'ok');
    await store.createRun(run());

    const retried = await engine.retryWithInput('r1', { fixed: true }, 'r1~retry~1');

    expect(retried).toEqual({ runId: 'r1~retry~1' });
    const fresh = await store.getRun('r1~retry~1');
    expect(fresh?.status).toBe('pending');
    expect(fresh?.recoveryAttempts ?? 0).toBe(0);
    expect((await store.getRun('r1'))?.status).toBe('dead'); // the original stays inspectable
  });
});
