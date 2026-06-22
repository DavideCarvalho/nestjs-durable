import type { HistoryEvent } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { Cancelled, NondeterminismError, StepFailed, Suspend } from './errors';
import { WorkflowContext } from './workflow-context';

describe('WorkflowContext.step', () => {
  it('runs the body once and records a recordStep command with the output', async () => {
    const ctx = new WorkflowContext('r1', []);
    let runs = 0;
    const out = await ctx.step('count', () => {
      runs += 1;
      return runs;
    });
    expect(out).toBe(1);
    expect(runs).toBe(1);
    expect(ctx.commands).toHaveLength(1);
    const cmd = ctx.commands[0];
    expect(cmd.kind).toBe('recordStep');
    if (cmd.kind === 'recordStep') {
      expect(cmd.seq).toBe(0);
      expect(cmd.name).toBe('count');
      expect(cmd.output).toBe(1);
      expect(typeof cmd.startedAt).toBe('number');
      expect(typeof cmd.finishedAt).toBe('number');
    }
  });

  it('replays the recorded value WITHOUT re-running the body', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'step', name: 'count', output: 42 }];
    const ctx = new WorkflowContext('r1', history);
    const out = await ctx.step('count', () => {
      throw new Error('body must not run on replay');
    });
    expect(out).toBe(42);
    expect(ctx.commands).toHaveLength(0);
  });

  it('records a failed recordStep and throws StepFailed when the body throws', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(
      ctx.step('boom', () => {
        throw new Error('kaboom');
      }),
    ).rejects.toBeInstanceOf(StepFailed);
    expect(ctx.commands).toHaveLength(1);
    const cmd = ctx.commands[0];
    expect(cmd.kind).toBe('recordStep');
    if (cmd.kind === 'recordStep') {
      expect(cmd.error?.message).toBe('kaboom');
      expect(cmd.output).toBeUndefined();
    }
  });

  it('re-raises StepFailed when replaying a recorded error', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'step', name: 'boom', error: { message: 'boom' } },
    ];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.step('boom', () => 1)).rejects.toThrow('boom');
  });

  it('captures step body events on the recordStep command', async () => {
    const ctx = new WorkflowContext('r1', []);
    await ctx.step('s', (log) => {
      log.info('hello');
      log.sub('proc-a', 'ok');
    });
    const cmd = ctx.commands[0];
    expect(cmd.kind).toBe('recordStep');
    if (cmd.kind === 'recordStep') {
      expect(cmd.events).toHaveLength(2);
      expect(cmd.events?.[0].message).toBe('hello');
      expect(cmd.events?.[1].name).toBe('proc-a');
      expect(cmd.events?.[1].status).toBe('ok');
    }
  });
});

describe('WorkflowContext.call', () => {
  it('pushes a call command and suspends', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.call('ingest', { a: 1 }, { group: 'g' })).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([
      { kind: 'call', seq: 0, name: 'ingest', group: 'g', input: { a: 1 } },
    ]);
  });

  it('replay-returns the recorded result on the next turn', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'call', name: 'ingest', output: 99 }];
    const ctx = new WorkflowContext('r1', history);
    expect(await ctx.call('ingest', { a: 1 }, { group: 'g' })).toBe(99);
    expect(ctx.commands).toHaveLength(0);
  });
});

describe('WorkflowContext.sleep', () => {
  it('pushes a sleep command and suspends', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.sleep(60_000)).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'sleep', seq: 0, ms: 60_000 }]);
  });

  it('replay-noops when recorded', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.sleep(60_000)).resolves.toBeUndefined();
    expect(ctx.commands).toHaveLength(0);
  });
});

describe('WorkflowContext.waitSignal', () => {
  it('pushes a waitSignal command and suspends when not delivered', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.waitSignal('approve')).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'waitSignal', seq: 0, signal: 'approve' }]);
  });

  it('consumes a pending signal at this seq', async () => {
    const ctx = new WorkflowContext('r1', [], {
      pendingSignals: [{ seq: 0, signal: 'approve', payload: { by: 'davi' } }],
    });
    expect(await ctx.waitSignal('approve')).toEqual({ by: 'davi' });
    expect(ctx.commands).toHaveLength(0);
  });

  it('replay-returns the recorded payload', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'signal', name: 'approve', output: { ok: 1 } },
    ];
    const ctx = new WorkflowContext('r1', history);
    expect(await ctx.waitSignal('approve')).toEqual({ ok: 1 });
  });
});

describe('WorkflowContext.startChild', () => {
  it('pushes a startChild command and suspends', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.startChild('child-wf', { x: 1 })).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([
      { kind: 'startChild', seq: 0, workflow: 'child-wf', input: { x: 1 } },
    ]);
  });

  it('replay-returns the recorded child output', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'child', name: 'child-wf', output: { done: true } },
    ];
    const ctx = new WorkflowContext('r1', history);
    expect(await ctx.startChild('child-wf', { x: 1 })).toEqual({ done: true });
  });
});

describe('WorkflowContext determinism', () => {
  it('raises NondeterminismError on a kind mismatch at a seq', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.call('a', null, { group: 'g' })).rejects.toBeInstanceOf(NondeterminismError);
  });

  it('raises NondeterminismError on a name mismatch at a seq', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'call', name: 'a', output: 1 }];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.call('b', null, { group: 'g' })).rejects.toBeInstanceOf(NondeterminismError);
  });
});

describe('WorkflowContext cancellation', () => {
  it('throws Cancelled at the op boundary when the run is cancelled', async () => {
    const ctx = new WorkflowContext('r1', [], { isCancelled: (id) => id === 'r1' });
    await expect(ctx.step('s', () => 1)).rejects.toBeInstanceOf(Cancelled);
  });
});

describe('WorkflowContext.replayEntry', () => {
  it('returns the raw entry without raising on a recorded error', () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'step', name: 's', error: { message: 'x' } }];
    const ctx = new WorkflowContext('r1', history);
    const ev = ctx.replayEntry(0, 'step', 's');
    expect(ev?.error?.message).toBe('x');
  });

  it('returns null when absent', () => {
    const ctx = new WorkflowContext('r1', []);
    expect(ctx.replayEntry(0, 'step', 's')).toBeNull();
  });

  it('still enforces the kind/name guard', () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const ctx = new WorkflowContext('r1', history);
    expect(() => ctx.replayEntry(0, 'step', 's')).toThrow(NondeterminismError);
  });
});
