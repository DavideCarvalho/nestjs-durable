import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * A workflow-task-capable Transport that records every dispatched group and captures the
 * `onDecision` handler so a test can deliver a decision directly (no dependency on setImmediate
 * timing) — the operator-drive-mode counterpart of `remote-by-convention.spec.ts`'s
 * `ConventionTransport`, but WITHOUT auto-completing: each assertion below drives the
 * dispatch/decision halves independently.
 */
class RecordingTransport implements Transport {
  readonly dispatchedGroups: string[] = [];
  private decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  constructor(private readonly liveGroups: string[]) {}

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return this.liveGroups;
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.dispatchedGroups.push(task.group);
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }

  /** Deliver a decision straight to the engine bound to this transport, bypassing dispatch timing. */
  async deliverDecision(decision: WorkflowDecision): Promise<void> {
    await this.decisionHandler?.(decision);
  }
}

function nowDate() {
  return new Date();
}

describe('operator drive mode', () => {
  it('an operator (namespace: undefined) picks up pending runs from every namespace via runPending, routing each to its tenant group', async () => {
    const store = new InMemoryStateStore();
    const created = nowDate();
    await store.createRun({
      id: 'default-pending',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'default',
      createdAt: created,
      updatedAt: created,
    });
    await store.createRun({
      id: 't1-pending',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 't1',
      createdAt: created,
      updatedAt: created,
    });
    const transport = new RecordingTransport(['processing', 'processing@t1']);
    const operator = new WorkflowEngine({
      store,
      transport,
      namespace: undefined,
      remoteByConvention: true,
    });

    await operator.runPending();

    // Both namespaces' pending runs were picked up (not just the operator's own — it has none) and
    // dispatch-and-suspended, each on ITS OWN tenant group.
    expect((await store.getRun('default-pending'))?.status).toBe('suspended');
    expect((await store.getRun('t1-pending'))?.status).toBe('suspended');
    expect(transport.dispatchedGroups.sort()).toEqual(['processing', 'processing@t1']);
  });

  it('an operator recovers incomplete (running) runs from every namespace', async () => {
    const store = new InMemoryStateStore();
    const created = nowDate();
    await store.createRun({
      id: 'default-running',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'running',
      input: {},
      namespace: 'default',
      createdAt: created,
      updatedAt: created,
    });
    await store.createRun({
      id: 't1-running',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'running',
      input: {},
      namespace: 't1',
      createdAt: created,
      updatedAt: created,
    });
    const transport = new RecordingTransport(['processing', 'processing@t1']);
    const operator = new WorkflowEngine({
      store,
      transport,
      namespace: undefined,
      remoteByConvention: true,
      runDispatcher: { dispatch: () => {} }, // no-op: inspect the re-enqueued row, don't re-execute it
    });

    await operator.recoverIncomplete();

    // Orphaned runs in BOTH namespaces are reclaimed (re-enqueued as pending), not just the ones
    // matching some fixed namespace.
    expect((await store.getRun('default-running'))?.status).toBe('pending');
    expect((await store.getRun('t1-running'))?.status).toBe('pending');
  });

  it('an operator resumes due timers from every namespace, routing each to its tenant group', async () => {
    const store = new InMemoryStateStore();
    const created = nowDate();
    const dueAt = Date.now() - 1_000;
    await store.createRun({
      id: 'default-due',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'suspended',
      wakeAt: dueAt,
      input: {},
      namespace: 'default',
      createdAt: created,
      updatedAt: created,
    });
    await store.createRun({
      id: 't1-due',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'suspended',
      wakeAt: dueAt,
      input: {},
      namespace: 't1',
      createdAt: created,
      updatedAt: created,
    });
    const transport = new RecordingTransport(['processing', 'processing@t1']);
    const operator = new WorkflowEngine({
      store,
      transport,
      namespace: undefined,
      remoteByConvention: true,
    });

    await operator.resumeDueTimers();

    // Both due timers fired (re-dispatched), each to its OWN tenant group.
    expect(transport.dispatchedGroups.sort()).toEqual(['processing', 'processing@t1']);
  });

  it('an operator resumes a foreign-namespace run without NamespaceMismatch, and applies its remote decision', async () => {
    const store = new InMemoryStateStore();
    const created = nowDate();
    await store.createRun({
      id: 't1-pending-resume',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 't1',
      createdAt: created,
      updatedAt: created,
    });
    const transport = new RecordingTransport(['processing', 'processing@t1']);
    const operator = new WorkflowEngine({
      store,
      transport,
      namespace: undefined,
      remoteByConvention: true,
    });

    // resume() must NOT throw NamespaceMismatch for a run outside any single namespace — an
    // operator belongs to every namespace. (If it throws, this test fails right here.)
    const resumed = await operator.resume('t1-pending-resume');
    expect(resumed.status).toBe('suspended');
    const suspended = await store.getRun('t1-pending-resume');
    expect(suspended?.status).toBe('suspended');
    expect(suspended?.awaitingDecisionTaskId).toBeDefined();
    const taskId = suspended?.awaitingDecisionTaskId;
    if (taskId === undefined) throw new Error('expected an awaited decision taskId');

    // The decision for that same-namespace-mismatched turn must be APPLIED (not dropped) — this is
    // completeRemoteDecision's own guard, exercised independently of resume()'s.
    await transport.deliverDecision({
      taskId,
      runId: 't1-pending-resume',
      status: 'completed',
      commands: [],
      output: { ok: true },
    });
    const settled = await store.getRun('t1-pending-resume');
    expect(settled?.status).toBe('completed');
    expect(settled?.output).toEqual({ ok: true });
  });

  it('start() via the onStartRun wire resolves the tenant-suffixed group: opts.namespace is stamped on the convention pre-check', async () => {
    const store = new InMemoryStateStore();
    // ONLY the tenant-suffixed group is live — the bare `processing` group is NOT. This is the
    // discriminating case: an operator starting a t1 run (opts.namespace: 't1') must resolve
    // `processing@t1`. Before the pre-check stamped the namespace it computed the BARE group, missed
    // it here, and threw "not registered" — orphaning the start-run wire path for a suffixed-only worker.
    const transport = new RecordingTransport(['processing@t1']);
    const operator = new WorkflowEngine({
      store,
      transport,
      namespace: undefined,
      remoteByConvention: true,
      runDispatcher: { dispatch: () => {} }, // no-op: inspect the created row, don't drive it further
    });

    const started = await operator.start('processing', { hello: 'world' }, 'wire-t1', {
      namespace: 't1',
    });
    expect(started.status).toBe('pending');
    const run = await store.getRun('wire-t1');
    expect(run?.namespace).toBe('t1');
    expect(run?.status).toBe('pending');
  });

  it('start() of a tenant workflow with NO live group still throws (unchanged failure mode)', async () => {
    const store = new InMemoryStateStore();
    const transport = new RecordingTransport([]); // nothing live
    const operator = new WorkflowEngine({
      store,
      transport,
      namespace: undefined,
      remoteByConvention: true,
      runDispatcher: { dispatch: () => {} },
    });
    await expect(
      operator.start('processing', {}, 'wire-none', { namespace: 't1' }),
    ).rejects.toThrow('not registered');
  });

  it('regression: a scoped engine (namespace: "default") still rejects and drops a t1 run exactly as before', async () => {
    const store = new InMemoryStateStore();
    const created = nowDate();
    await store.createRun({
      id: 'default-scoped-pending',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'default',
      createdAt: created,
      updatedAt: created,
    });
    await store.createRun({
      id: 't1-scoped-pending',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 't1',
      createdAt: created,
      updatedAt: created,
    });
    // Already awaiting a remote decision from a prior (foreign) turn, so completeRemoteDecision's
    // guard is exercised directly, independent of resume()'s own guard.
    await store.createRun({
      id: 't1-scoped-suspended',
      workflow: 'processing',
      workflowVersion: '1',
      status: 'suspended',
      awaitingDecisionTaskId: 'foreign-task',
      input: {},
      namespace: 't1',
      createdAt: created,
      updatedAt: created,
    });
    const transport = new RecordingTransport(['processing', 'processing@t1']);
    const scoped = new WorkflowEngine({
      store,
      transport,
      namespace: 'default',
      remoteByConvention: true,
    });

    // resume() of a foreign-namespace run still throws NamespaceMismatch, exactly as today.
    await expect(scoped.resume('t1-scoped-pending')).rejects.toThrow('namespace-mismatch');

    // Its decision is still dropped (not applied) rather than settling the run.
    await transport.deliverDecision({
      taskId: 'foreign-task',
      runId: 't1-scoped-suspended',
      status: 'completed',
      commands: [],
      output: { ok: true },
    });
    expect((await store.getRun('t1-scoped-suspended'))?.status).toBe('suspended');

    // runPending still ignores the t1 run — only its own namespace's pending run is picked up.
    await scoped.runPending();
    expect((await store.getRun('default-scoped-pending'))?.status).toBe('suspended');
    expect((await store.getRun('t1-scoped-pending'))?.status).toBe('pending'); // untouched
  });
});
