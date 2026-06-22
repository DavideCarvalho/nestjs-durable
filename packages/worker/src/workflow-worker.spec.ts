import type { HistoryEvent, RemoteStepDef, WorkflowTask } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { WorkflowWorker } from './workflow-worker';

/** A minimal typed remote step def for driving `ctx.call` in these tests (only name/group are read). */
function remote(name: string, group = 'g'): RemoteStepDef {
  return { name, group, input: {} as never, output: {} as never, __remote: true };
}

function task(over: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    taskId: 't0',
    runId: 'r1',
    workflow: 'wf',
    workflowVersion: '1',
    input: null,
    history: [],
    pendingSignals: [],
    group: 'wf',
    attempt: 1,
    ...over,
  };
}

describe('WorkflowWorker.processTask decision mapping', () => {
  it('maps a normal return to completed', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async () => ({ ok: true }));
    const d = await wf.processTask(task());
    expect(d.status).toBe('completed');
    expect(d.output).toEqual({ ok: true });
    expect(d.commands).toEqual([]);
  });

  it('maps a Suspend to continue with the commands', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => {
      await ctx.call(remote('ingest'), null);
    });
    const d = await wf.processTask(task());
    expect(d.status).toBe('continue');
    expect(d.commands.map((c) => c.kind)).toEqual(['call']);
  });

  it('maps a StepFailed to failed with the error', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => {
      await ctx.step('boom', () => {
        throw new Error('kaboom');
      });
    });
    const d = await wf.processTask(task());
    expect(d.status).toBe('failed');
    expect(d.error?.message).toBe('kaboom');
    // the failed recordStep still rides back so the engine can persist partial progress
    expect(d.commands.map((c) => c.kind)).toEqual(['recordStep']);
  });

  it('catches a StepFailed inside workflow code and completes', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => {
      try {
        await ctx.call(remote('risky'), null);
        return { ok: true };
      } catch {
        return { ok: false, compensated: true };
      }
    });
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'call', name: 'risky', error: { message: 'boom' } },
    ];
    const d = await wf.processTask(task({ history }));
    expect(d.status).toBe('completed');
    expect(d.output).toEqual({ ok: false, compensated: true });
  });

  it('maps an uncaught failure to failed', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => {
      await ctx.call(remote('risky'), null);
    });
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'call', name: 'risky', error: { message: 'boom' } },
    ];
    const d = await wf.processTask(task({ history }));
    expect(d.status).toBe('failed');
    expect(d.error?.message).toBe('boom');
  });

  it('maps a cancellation at an op boundary to cancelled', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => {
      await ctx.step('s', () => 1);
    });
    const d = await wf.processTask(task(), { isCancelled: (id) => id === 'r1' });
    expect(d.status).toBe('cancelled');
  });

  it('fails cleanly for an unknown workflow', async () => {
    const wf = new WorkflowWorker();
    const d = await wf.processTask(task({ workflow: 'nope' }));
    expect(d.status).toBe('failed');
    expect(d.error?.code).toBe('no_workflow');
  });

  it('detects nondeterminism and fails loudly', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx) => {
      await ctx.call(remote('a'), null);
    });
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const d = await wf.processTask(task({ history }));
    expect(d.status).toBe('failed');
    expect(d.error?.message).toContain('history at seq 0');
  });
});

describe('WorkflowWorker end-to-end across turns', () => {
  it('runs a local step then a remote call to completion', async () => {
    const wf = new WorkflowWorker();
    wf.register('wf', async (ctx, input: { base: string }) => {
      const a = await ctx.step('s', () => 1);
      const r = await ctx.call(remote('ingest'), { a, base: input.base });
      return { a, r };
    });

    // Turn 1: empty history → runs the step, blocks on the call.
    const d1 = await wf.processTask(task({ input: { base: 'b1' } }));
    expect(d1.status).toBe('continue');
    expect(d1.commands.map((c) => c.kind)).toEqual(['recordStep', 'call']);
    const step = d1.commands[0];
    expect(step.kind).toBe('recordStep');
    if (step.kind === 'recordStep') expect(step.output).toBe(1);
    const call = d1.commands[1];
    expect(call.kind).toBe('call');
    if (call.kind === 'call') {
      expect(call.name).toBe('ingest');
      expect(call.input).toEqual({ a: 1, base: 'b1' });
    }

    // Turn 2: history has the step result + the call result → completes.
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'step', name: 's', output: 1 },
      { seq: 1, kind: 'call', name: 'ingest', output: { rows: 42 } },
    ];
    const d2 = await wf.processTask(task({ input: { base: 'b1' }, history }));
    expect(d2.status).toBe('completed');
    expect(d2.output).toEqual({ a: 1, r: { rows: 42 } });
    expect(d2.commands).toEqual([]);
  });
});
