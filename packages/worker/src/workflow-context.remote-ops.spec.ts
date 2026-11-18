import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type HistoryEvent,
  REMOTE_WORKFLOW_FEATURES,
  SignalTimeoutError,
  type StepRef,
  type WorkflowTask,
  isWorkflowControlFlowSignal,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { StepFailed, Suspend, UnsupportedByControlPlane, UnsupportedOnThinWorker } from './errors';
import { WorkflowContext } from './workflow-context';
import { WorkflowWorker } from './workflow-worker';

/** A context dispatched by a control plane that applies every negotiated command. */
const ctxOf = (history: HistoryEvent[] = [], runId = 'r1') =>
  new WorkflowContext(runId, history, { features: [...REMOTE_WORKFLOW_FEATURES] });

/** A context dispatched by a control plane from before feature negotiation (no `features`). */
const legacyCtx = (history: HistoryEvent[] = []) => new WorkflowContext('r1', history);

describe('ctx.step carries its step policy on the call (callPolicy)', () => {
  it('per-call opts become the call policy', async () => {
    const ctx = ctxOf();
    await expect(
      ctx.step('charge', { n: 1 }, { retries: 3, backoff: 'exp', backoffMs: 100, timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([
      {
        kind: 'call',
        seq: 0,
        name: 'charge',
        group: '',
        input: { n: 1 },
        policy: { retries: 3, backoff: 'exp', backoffMs: 100, timeoutMs: 500 },
      },
    ]);
  });

  it('a @Step-stamped policy is carried, a per-call field overriding it', async () => {
    const charge = ((_: unknown) => undefined) as StepRef;
    charge[DURABLE_STEP_NAME] = 'Billing.charge';
    charge[DURABLE_STEP_CONFIG] = { retries: 5, backoffMs: 50, jitter: true };
    const ctx = ctxOf();
    await expect(ctx.step(charge, {}, { backoffMs: 10 })).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands[0]).toMatchObject({
      kind: 'call',
      name: 'Billing.charge',
      policy: { retries: 5, backoffMs: 10, jitter: true },
    });
  });

  it('a call with no policy stays wire-identical (no policy field), even on a legacy control plane', async () => {
    const ctx = legacyCtx();
    await expect(ctx.step('charge', 1, { priority: 3 })).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'call', seq: 0, name: 'charge', group: '', input: 1 }]);
  });

  it('a policy on a control plane without callPolicy fails the turn instead of being ignored', async () => {
    const ctx = legacyCtx();
    const err = await ctx.step('charge', 1, { retries: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedByControlPlane);
    expect((err as UnsupportedByControlPlane).feature).toBe('callPolicy');
    expect((err as UnsupportedByControlPlane).code).toBe('control_plane_unsupported');
    expect(ctx.commands).toEqual([]);
  });

  it('a failed attempt the policy retries is re-emitted, not raised', async () => {
    const ctx = ctxOf([
      { seq: 0, kind: 'call', name: 'charge', error: { message: 'boom' }, attempts: 1 },
    ]);
    await expect(ctx.step('charge', 1, { retries: 2 })).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([
      { kind: 'call', seq: 0, name: 'charge', group: '', input: 1, policy: { retries: 2 } },
    ]);
  });

  it('raises once the attempts are spent', async () => {
    const ctx = ctxOf([
      { seq: 0, kind: 'call', name: 'charge', error: { message: 'boom' }, attempts: 2 },
    ]);
    const err = await ctx.step('charge', 1, { retries: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailed);
    expect(ctx.commands).toEqual([]);
  });

  it('raises a non-retryable failure at once', async () => {
    const ctx = ctxOf([
      {
        seq: 0,
        kind: 'call',
        name: 'charge',
        error: { message: 'declined', retryable: false },
        attempts: 1,
      },
    ]);
    await expect(ctx.step('charge', 1, { retries: 5 })).rejects.toBeInstanceOf(StepFailed);
  });

  it('with a timeoutMs a reported failure is final (only a timeout is retried), as in-process', async () => {
    const ctx = ctxOf([
      { seq: 0, kind: 'call', name: 'charge', error: { message: 'boom' }, attempts: 1 },
    ]);
    await expect(ctx.step('charge', 1, { retries: 3, timeoutMs: 100 })).rejects.toBeInstanceOf(
      StepFailed,
    );
  });
});

describe('ctx.sleepUntil (sleepUntil)', () => {
  it('emits an absolute deadline and suspends', async () => {
    const ctx = ctxOf();
    await expect(ctx.sleepUntil(new Date(1_700_000_000_000))).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'sleepUntil', seq: 0, until: 1_700_000_000_000 }]);
  });

  it('replays a fired timer', async () => {
    const ctx = ctxOf([{ seq: 0, kind: 'timer', name: 'sleep:0' }]);
    await ctx.sleepUntil(5);
    expect(ctx.commands).toEqual([]);
  });

  it('fails clearly on a control plane without it', async () => {
    await expect(legacyCtx().sleepUntil(5)).rejects.toBeInstanceOf(UnsupportedByControlPlane);
  });
});

describe('ctx.waitForSignal with timeoutMs (waitSignalTimeout)', () => {
  it('takes the deadline seq then the wait seq, as in-process', async () => {
    const ctx = ctxOf();
    await expect(ctx.waitForSignal('approve', { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      Suspend,
    );
    expect(ctx.commands).toEqual([
      { kind: 'waitSignalTimeout', seq: 1, deadlineSeq: 0, signal: 'approve', timeoutMs: 5_000 },
    ]);
  });

  it('returns the signal when it landed', async () => {
    const ctx = ctxOf([{ seq: 1, kind: 'signal', output: { ok: true } }]);
    expect(await ctx.waitForSignal('approve', { timeoutMs: 5_000 })).toEqual({ ok: true });
  });

  it('the signal wins when both the signal and the deadline are in history', async () => {
    const ctx = ctxOf([
      { seq: 0, kind: 'timer', name: 'timeout:approve' },
      { seq: 1, kind: 'signal', output: 'yes' },
    ]);
    expect(await ctx.waitForSignal('approve', { timeoutMs: 5_000 })).toBe('yes');
  });

  it('raises SignalTimeoutError once the deadline fired', async () => {
    const ctx = ctxOf([{ seq: 0, kind: 'timer', name: 'timeout:approve' }]);
    const err = await ctx.waitForSignal('approve', { timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignalTimeoutError);
    expect((err as SignalTimeoutError).token).toBe('approve');
    // The next op lands after both positions.
    await expect(ctx.sleep(1)).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'sleep', seq: 2, ms: 1 }]);
  });

  it('fails clearly on a control plane without it', async () => {
    await expect(legacyCtx().waitForSignal('a', { timeoutMs: 1 })).rejects.toBeInstanceOf(
      UnsupportedByControlPlane,
    );
  });
});

describe('ctx.waitForEvent (waitEvent)', () => {
  it('emits an unbounded event wait with its match', async () => {
    const ctx = ctxOf();
    await expect(ctx.waitForEvent('order.paid', { match: { id: 7 } })).rejects.toBeInstanceOf(
      Suspend,
    );
    expect(ctx.commands).toEqual([
      { kind: 'waitEvent', seq: 0, name: 'order.paid', match: { id: 7 } },
    ]);
  });

  it('emits a bounded wait on two seqs', async () => {
    const ctx = ctxOf();
    await expect(ctx.waitForEvent('order.paid', { timeoutMs: 100 })).rejects.toBeInstanceOf(
      Suspend,
    );
    expect(ctx.commands).toEqual([
      { kind: 'waitEvent', seq: 1, name: 'order.paid', deadlineSeq: 0, timeoutMs: 100 },
    ]);
  });

  it('returns the delivered payload', async () => {
    const ctx = ctxOf([{ seq: 0, kind: 'signal', output: { id: 7 } }]);
    expect(await ctx.waitForEvent('order.paid')).toEqual({ id: 7 });
  });

  it('raises SignalTimeoutError for event:<name> once the deadline fired', async () => {
    const ctx = ctxOf([{ seq: 0, kind: 'timer' }]);
    const err = await ctx.waitForEvent('order.paid', { timeoutMs: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignalTimeoutError);
    expect((err as SignalTimeoutError).token).toBe('event:order.paid');
  });

  it('fails clearly on a control plane without it', async () => {
    await expect(legacyCtx().waitForEvent('e')).rejects.toBeInstanceOf(UnsupportedByControlPlane);
  });
});

describe('ctx.startChild (spawnChild)', () => {
  it('emits the spawn, returns the child id at once and the turn goes on', async () => {
    const ctx = ctxOf();
    const id = await ctx.startChild('report', { n: 1 }, { priority: 4 });
    expect(id).toBe('r1.child.0');
    await expect(ctx.sleep(10)).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([
      {
        kind: 'spawnChild',
        seq: 0,
        workflow: 'report',
        input: { n: 1 },
        childId: 'r1.child.0',
        priority: 4,
      },
      { kind: 'sleep', seq: 1, ms: 10 },
    ]);
  });

  it('honours an explicit child id (string shorthand)', async () => {
    const ctx = ctxOf();
    expect(await ctx.startChild('report', {}, 'my-child')).toBe('my-child');
    expect(ctx.commands[0]).toMatchObject({ kind: 'spawnChild', childId: 'my-child' });
  });

  it('replays the recorded spawn without emitting it again', async () => {
    const ctx = ctxOf([{ seq: 0, kind: 'step', name: 'spawn:my-child', output: 'my-child' }]);
    expect(await ctx.startChild('report', {}, 'my-child')).toBe('my-child');
    expect(ctx.commands).toEqual([]);
  });

  it('names the options the remote protocol does not carry yet', async () => {
    await expect(ctxOf().startChild('report', {}, { version: '2' })).rejects.toBeInstanceOf(
      UnsupportedOnThinWorker,
    );
    await expect(
      ctxOf().startChild('report', {}, { parentClose: 'abandon' }),
    ).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });

  it('fails clearly on a control plane without it', async () => {
    await expect(legacyCtx().startChild('report', {})).rejects.toBeInstanceOf(
      UnsupportedByControlPlane,
    );
  });
});

describe('ctx.continueAsNew (continueAsNew)', () => {
  it('ends the turn as a control-flow signal with continueAsNew as its last command', async () => {
    const ctx = ctxOf([{ seq: 0, kind: 'timer' }]);
    await ctx.sleep(1);
    const thrown = await ctx.continueAsNew({ cursor: 2 }).catch((e: unknown) => e);
    expect(isWorkflowControlFlowSignal(thrown)).toBe(true);
    expect(ctx.commands).toEqual([{ kind: 'continueAsNew', seq: 1, input: { cursor: 2 } }]);
  });

  it('WorkflowWorker turns it into a completed decision carrying the handoff', async () => {
    const worker = new WorkflowWorker('g').register('loop', async (ctx, input) => {
      const n = (input as { n: number }).n;
      if (n < 3) await ctx.continueAsNew({ n: n + 1 });
      return n;
    });
    const task: WorkflowTask = {
      taskId: 't1',
      runId: 'r1',
      workflow: 'loop',
      workflowVersion: '1',
      input: { n: 1 },
      history: [],
      group: 'g',
      attempt: 1,
      features: [...REMOTE_WORKFLOW_FEATURES],
    };
    const decision = await worker.processTask(task);
    expect(decision.status).toBe('completed');
    expect(decision.commands).toEqual([{ kind: 'continueAsNew', seq: 0, input: { n: 2 } }]);
  });

  it('fails the turn clearly on a control plane without it', async () => {
    const worker = new WorkflowWorker('g').register('loop', async (ctx) => ctx.continueAsNew({}));
    const decision = await worker.processTask({
      taskId: 't1',
      runId: 'r1',
      workflow: 'loop',
      workflowVersion: '1',
      input: {},
      history: [],
      group: 'g',
      attempt: 1,
    });
    expect(decision.status).toBe('failed');
    expect(decision.error?.code).toBe('control_plane_unsupported');
    expect(decision.error?.message).toContain('continueAsNew');
    expect(decision.commands).toEqual([]);
  });
});

describe('ctx.setEvent', () => {
  it('records the event:<key> step the control plane serves to engine.getEvent', async () => {
    // A recordStep every control plane applies — no feature needed.
    const ctx = legacyCtx();
    await ctx.setEvent('progress', { pct: 50 });
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0]).toMatchObject({
      kind: 'recordStep',
      seq: 0,
      name: 'event:progress',
      output: { pct: 50 },
    });
  });

  it('replays without recording it again', async () => {
    const ctx = ctxOf([{ seq: 0, kind: 'step', name: 'event:progress', output: { pct: 50 } }]);
    await ctx.setEvent('progress', { pct: 50 });
    expect(ctx.commands).toEqual([]);
  });
});
